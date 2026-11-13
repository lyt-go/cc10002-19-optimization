"""同步通道业务规则：状态流转、字段校验与筛选口径都收在这里。

断点续传的判定与快照统一走 app.services.resume 的注册表——
同步详情、同步列表与变更审计读的是同一份续传结论，本模块不另存副本。
"""
from __future__ import annotations

from typing import Any

from app.services import auditlog as auditlog_service
from app.services.resume import max_lag_ms_of, registry
from app.store import store

MODULE = "sync"
REQUIRED_FIELDS = ["通道编号", "来源表名", "目标表名"]
OPTIONAL_FIELDS = ["同步方式", "延迟秒数", "并发度", "断点续传"]
STATUS_ORDER = ["草稿", "通道审批中", "已启用", "已停用"]
ACTION_RULES = {"提交通道审批": "通道审批中", "启用通道": "已启用", "停用通道": "已停用"}
NEGATIVE_ACTIONS = ["停用通道"]


class SyncService:
    def list_entries(
        self,
        *,
        keyword: str | None = None,
        status: str | None = None,
        page: int = 1,
        size: int = 20,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = store.rows(MODULE)
        if keyword:
            rows = [row for row in rows if keyword in str(row.get("通道编号", ""))]
        if status:
            rows = [row for row in rows if row.get("status") == status]
        total = len(rows)
        start = max(page - 1, 0) * size
        # 列表行挂上精简续传结论（续传水位/待补区间），与审计详情读同一来源
        return [self._with_summary(row) for row in rows[start:start + size]], total

    def get_entry(self, entry_id: int) -> dict[str, Any] | None:
        row = store.find(MODULE, entry_id)
        if row is None:
            return None
        detail = dict(row)
        detail["resume"] = registry.snapshot(entry_id)
        return detail

    def create_entry(self, values: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
        missing = [field for field in REQUIRED_FIELDS if not str(values.get(field) or "").strip()]
        if missing:
            return None, missing
        rows = store.rows(MODULE)
        entry = {"id": max((int(row.get("id", 0)) for row in rows), default=0) + 1}
        entry.update({field: values.get(field) for field in REQUIRED_FIELDS})
        for field in OPTIONAL_FIELDS:
            if values.get(field) is not None:
                entry[field] = values.get(field)
        entry["status"] = STATUS_ORDER[0]
        entry["pending"] = True
        entry["abnormal"] = False
        rows.append(entry)
        return entry, []

    def run_action(self, entry_id: int, action: str) -> tuple[dict[str, Any] | None, str]:
        entry = store.find(MODULE, entry_id)
        if entry is None:
            return None, f"同步通道 {entry_id} 不存在或已归档"
        if action not in ACTION_RULES:
            return None, f"动作「{action}」不属于同步通道可执行范围"
        target = ACTION_RULES[action]
        if target not in STATUS_ORDER:
            return None, f"目标状态「{target}」不在允许的状态序列里"
        # 停用只改通道自身状态：历史成功同步的审计记录与续传快照都保持原样，不回写
        entry["status"] = target
        entry["pending"] = target != STATUS_ORDER[-1]
        entry["abnormal"] = action in NEGATIVE_ACTIONS
        return entry, f"同步通道已{action}"

    # ---- 断点续传：读取与提交两个业务入口 ----

    def get_resume(self, entry_id: int) -> dict[str, Any] | None:
        """同步详情侧的续传结论：当前快照 + 提交表单需要的默认值。"""
        channel = store.find(MODULE, entry_id)
        if channel is None:
            return None
        snapshot = registry.snapshot(entry_id)
        seq = int(snapshot["channel_seq"]) if snapshot else 0
        return {
            "channel_id": entry_id,
            "通道编号": channel.get("通道编号"),
            "同步方式": channel.get("同步方式") or "增量同步",
            "snapshot": snapshot,
            "defaults": {
                "source_watermark": (snapshot or {}).get("source_watermark") or "",
                "ack_lsn": (snapshot or {}).get("ack_lsn") or "",
                "max_lag_ms": max_lag_ms_of(channel),
                "schema_version": (snapshot or {}).get("schema_version") or "v1",
                "suggested_token": f"{channel.get('通道编号', f'CH-{entry_id}')}-r{seq + 1}",
            },
        }

    def commit_resume(self, entry_id: int, values: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
        """提交一轮同步结论：判定续传方式、推进断点、把同一份结论写进变更审计。"""
        channel = store.find(MODULE, entry_id)
        if channel is None:
            return None, f"同步通道 {entry_id} 不存在或已归档"
        try:
            result = registry.commit(channel, values)
        except (ValueError, TypeError) as error:
            return None, f"续传提交被拒绝：{error}"
        snapshot = result["snapshot"]
        if result["duplicate"]:
            return {"snapshot": snapshot, "duplicate": True, "conflict": False, "audit_id": None}, "重复提交已去重，沿用首次提交的续传结论"
        audit_entry = auditlog_service.record_sync_resume(result["audit"])
        # 通道行同步展示最新结论，列表页与审计详情看到同一续传水位
        channel["断点续传"] = snapshot["decision"]
        channel["最后同步时间"] = snapshot["updated_at"]
        message = f"续传结论：{snapshot['decision']}，确认水位 {snapshot['ack_lsn']}"
        if result["conflict"]:
            message += "（与已确认水位冲突，已按目标端更晚水位处理）"
        return {
            "snapshot": snapshot,
            "duplicate": False,
            "conflict": result["conflict"],
            "audit_id": audit_entry.get("id"),
        }, message

    @staticmethod
    def _with_summary(row: dict[str, Any]) -> dict[str, Any]:
        item = dict(row)
        item["resume"] = registry.summary(int(row.get("id", 0)))
        return item
