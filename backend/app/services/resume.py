"""断点续传判定引擎：同步通道与变更审计共用的续传结论唯一来源。

判定规则（输入：源端水位、目标确认状态、同步方式、当前延迟与最大延迟阈值）：

1. 源表 schema 或同步方式变化 —— 旧确认区间整体失效，全量重传；
2. 源端水位变化，或目标端未确认到上一水位 —— 旧断点立即失效，
   只补目标端确认缺失的区间 [ack_lsn, source_watermark]，已完成区间不重复写入；
3. 延迟未超阈值且源端水位未变、目标端已确认 —— 直接复用断点，不回放；
4. 延迟超过阈值 —— 断点失效重估，同样只补缺失区间（无缺失则不回放）。

并发与幂等：

- 同一通道的提交按通道级锁串行化；
- idempotency_token 与上一已提交轮次相同时直接返回首次结果，重复提交只保留一次结果；
- 并发更新断点冲突时，以已确认写入目标端的更晚水位为准，不允许回退。
"""
from __future__ import annotations

import threading
from datetime import datetime
from typing import Any

DECISION_REUSE = "复用断点"
DECISION_RESUME = "增量续传"
DECISION_FULL = "全量重传"

ORIGIN_WATERMARK = "00:00"
DEFAULT_MAX_LAG_MS = 300_000


def parse_watermark(value: Any) -> int:
    """水位统一折算成可比较的整数：支持 'HH:MM'、整数字符串与整数。"""
    if value is None:
        return -1
    text = str(value).strip()
    if not text:
        return -1
    if ":" in text:
        hours, _, minutes = text.partition(":")
        return int(hours) * 60 + int(minutes)
    return int(float(text))


def parse_ranges(raw: Any) -> list[list[str]]:
    """把失败区间入参规整成 [[start, end], ...]，非法区间直接报错而不是静默丢弃。"""
    ranges: list[list[str]] = []
    for item in raw or []:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise ValueError(f"失败区间「{item}」应为 [开始水位, 结束水位]")
        start, end = str(item[0]).strip(), str(item[1]).strip()
        if parse_watermark(start) > parse_watermark(end):
            raise ValueError(f"失败区间「{start}~{end}」起点晚于终点")
        ranges.append([start, end])
    return ranges


def max_lag_ms_of(channel: dict[str, Any]) -> int:
    """从通道的「延迟秒数」推导最大延迟阈值，解析不了就按默认 300 秒。"""
    try:
        seconds = float(str(channel.get("延迟秒数") or "").strip())
    except ValueError:
        return DEFAULT_MAX_LAG_MS
    return int(seconds * 1000) if seconds > 0 else DEFAULT_MAX_LAG_MS


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _render_ranges(ranges: list[list[str]]) -> str:
    return "、".join(f"{start}~{end}" for start, end in ranges) or "无"


class ResumeRegistry:
    """每个同步通道一份续传快照；提交判定走通道级锁，保证并发下结论一致。"""

    def __init__(self) -> None:
        self._states: dict[int, dict[str, Any]] = {}
        self._locks: dict[int, threading.Lock] = {}
        self._guard = threading.Lock()

    # ---- 读取路径：同步详情、同步列表、审计详情都从这里取同一份结论 ----

    def snapshot(self, channel_id: int) -> dict[str, Any] | None:
        state = self._states.get(channel_id)
        return dict(state) if state else None

    def summary(self, channel_id: int) -> dict[str, Any] | None:
        """列表页用的精简结论：续传水位、待补区间与最近判定。"""
        state = self._states.get(channel_id)
        if state is None:
            return None
        return {
            "ack_lsn": state["ack_lsn"],
            "pending_range": state["pending_range"],
            "decision": state["decision"],
            "lag_ms": state["lag_ms"],
        }

    def current_seq(self, channel_id: int) -> int:
        state = self._states.get(channel_id)
        return int(state["channel_seq"]) if state else 0

    # ---- 判定：纯函数，不写状态 ----

    def evaluate(
        self,
        state: dict[str, Any] | None,
        *,
        source_watermark: str,
        lag_ms: int,
        max_lag_ms: int,
        schema_version: str,
        sync_mode: str,
    ) -> dict[str, Any]:
        if state is None:
            return {
                "decision": DECISION_FULL,
                "pending_range": [ORIGIN_WATERMARK, source_watermark],
                "reason": "首次建立断点，从起始水位全量初始化",
            }
        if schema_version != state["schema_version"] or sync_mode != state["sync_mode"]:
            return {
                "decision": DECISION_FULL,
                "pending_range": [ORIGIN_WATERMARK, source_watermark],
                "reason": "源表 schema 或同步方式变化，旧确认区间失效，全量重传",
            }
        watermark_changed = parse_watermark(source_watermark) != parse_watermark(state["source_watermark"])
        target_unconfirmed = parse_watermark(state["ack_lsn"]) < parse_watermark(state["source_watermark"])
        gap: list[str] | None = None
        if parse_watermark(state["ack_lsn"]) < parse_watermark(source_watermark):
            gap = [state["ack_lsn"], source_watermark]
        if watermark_changed or target_unconfirmed:
            return {
                "decision": DECISION_RESUME,
                "pending_range": gap,
                "reason": "源端水位变化或目标端未确认，旧断点立即失效，只补确认缺失的区间",
            }
        if lag_ms <= max_lag_ms:
            return {
                "decision": DECISION_REUSE,
                "pending_range": None,
                "reason": "延迟未超阈值且源端水位未变，直接复用断点",
            }
        return {
            "decision": DECISION_RESUME,
            "pending_range": gap,
            "reason": "延迟超过阈值，断点失效重估，只补确认缺失的区间",
        }

    # ---- 提交路径：一轮同步落断点，返回新快照与审计载荷 ----

    def commit(self, channel: dict[str, Any], values: dict[str, Any]) -> dict[str, Any]:
        channel_id = int(channel["id"])
        lock = self._lock_for(channel_id)
        with lock:
            state = self._states.get(channel_id)
            token = str(values.get("idempotency_token") or "").strip()
            if not token:
                raise ValueError("缺少幂等令牌 idempotency_token，无法判定重复提交")
            if state is not None and token == state["idempotency_token"]:
                # 重复提交：不推进水位、不写审计，只返回首次提交保留的结果
                return {"snapshot": dict(state), "audit": None, "duplicate": True, "conflict": False}

            source_watermark = str(values.get("source_watermark") or "").strip()
            ack_lsn = str(values.get("ack_lsn") or "").strip()
            parse_watermark(source_watermark)  # 校验格式，非法水位直接抛错
            parse_watermark(ack_lsn)
            lag_ms = int(values.get("lag_ms") or 0)
            max_lag_ms = max_lag_ms_of(channel)
            schema_version = str(values.get("schema_version") or (state or {}).get("schema_version") or "v1")
            sync_mode = str(channel.get("同步方式") or "增量同步")
            failed_ranges = parse_ranges(values.get("failed_ranges"))

            verdict = self.evaluate(
                state,
                source_watermark=source_watermark,
                lag_ms=lag_ms,
                max_lag_ms=max_lag_ms,
                schema_version=schema_version,
                sync_mode=sync_mode,
            )

            # 冲突裁决：已确认写入目标端的更晚水位优先，断点不允许回退
            conflict = False
            if state is not None and parse_watermark(ack_lsn) < parse_watermark(state["ack_lsn"]):
                conflict = True
                ack_lsn = state["ack_lsn"]

            full_replay = verdict["decision"] == DECISION_FULL
            if full_replay or state is None:
                confirmed: list[list[str]] = []
                if parse_watermark(ack_lsn) > parse_watermark(ORIGIN_WATERMARK):
                    confirmed.append([ORIGIN_WATERMARK, ack_lsn])
            else:
                confirmed = [list(item) for item in state["confirmed_ranges"]]
                if parse_watermark(ack_lsn) > parse_watermark(state["ack_lsn"]):
                    confirmed.append([state["ack_lsn"], ack_lsn])

            pending = verdict["pending_range"]
            if pending and parse_watermark(ack_lsn) >= parse_watermark(pending[1]):
                pending = None
            if pending is None and parse_watermark(ack_lsn) < parse_watermark(source_watermark):
                pending = [ack_lsn, source_watermark]

            snapshot = {
                "channel_id": channel_id,
                "channel_seq": (int(state["channel_seq"]) if state else 0) + 1,
                "source_watermark": source_watermark,
                "ack_lsn": ack_lsn,
                "lag_ms": lag_ms,
                "max_lag_ms": max_lag_ms,
                "pending_range": pending,
                "idempotency_token": token,
                "ack_summary": self._ack_summary(confirmed, ack_lsn, pending),
                "decision": verdict["decision"],
                "decision_reason": verdict["reason"],
                "sync_mode": sync_mode,
                "schema_version": schema_version,
                "confirmed_ranges": confirmed,
                "failed_ranges": failed_ranges,
                "updated_at": _now(),
            }
            self._states[channel_id] = snapshot
            return {
                "snapshot": dict(snapshot),
                "audit": self._audit_payload(channel, state, snapshot, conflict),
                "duplicate": False,
                "conflict": conflict,
            }

    # ---- 内部 helpers ----

    def _lock_for(self, channel_id: int) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(channel_id, threading.Lock())

    @staticmethod
    def _ack_summary(confirmed: list[list[str]], ack_lsn: str, pending: list[str] | None) -> str:
        summary = f"目标端已确认 {len(confirmed)} 个区间，确认到 {ack_lsn}"
        if pending:
            summary += f"；待补 {pending[0]}~{pending[1]}"
        else:
            summary += "；无待补区间"
        return summary

    @staticmethod
    def _audit_payload(
        channel: dict[str, Any],
        state: dict[str, Any] | None,
        snapshot: dict[str, Any],
        conflict: bool,
    ) -> dict[str, Any]:
        """交给变更审计落库的载荷：失败区间与当时水位都冻结在快照里。"""
        if conflict:
            change_type = "续传冲突裁决"
        elif snapshot["decision"] == DECISION_FULL:
            change_type = "全量重传"
        elif snapshot["decision"] == DECISION_REUSE:
            change_type = "断点复用"
        else:
            change_type = "增量续传"
        return {
            "操作表名": channel.get("目标表名") or "",
            "变更类型": change_type,
            "变更前值": (state or {}).get("ack_lsn") or ORIGIN_WATERMARK,
            "变更后值": snapshot["ack_lsn"],
            "操作人": "同步调度",
            "变更原因": snapshot["decision_reason"],
            "通道编号": channel.get("通道编号") or "",
            "channel_id": int(channel["id"]),
            "channel_seq": snapshot["channel_seq"],
            "失败区间": _render_ranges(snapshot["failed_ranges"]),
            "续传水位": snapshot["ack_lsn"],
            "resume_snapshot": dict(snapshot),
        }


registry = ResumeRegistry()


def bootstrap(seed_states: list[dict[str, Any]]) -> None:
    """把示例续传状态装进注册表；重复调用保持幂等，避免热重载叠数据。"""
    for state in seed_states:
        channel_id = int(state["channel_id"])
        if channel_id not in registry._states:  # noqa: SLF001 - 启动期初始化，允许触达内部表
            registry._states[channel_id] = dict(state)  # noqa: SLF001
