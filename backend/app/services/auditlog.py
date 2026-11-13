"""变更审计业务规则：状态流转、字段校验与筛选口径都收在这里。

同步续传产生的审计记录由同步模块通过 record_sync_resume 写入：
条目里冻结了当时的续传快照（失败区间、当时水位），后续停用通道不会回写这些历史。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from app.services.resume import registry
from app.store import store

MODULE = "auditlog"
REQUIRED_FIELDS = ["记录编号", "操作表名", "变更类型"]
STATUS_ORDER = ["草稿", "已记录", "已复核"]
ACTION_RULES = {"确认记录": "已记录", "提交复核": "已复核"}
NEGATIVE_ACTIONS = []


class AuditlogService:
    def list_entries(
        self,
        *,
        keyword: str | None = None,
        status: str | None = None,
        channel: str | None = None,
        page: int = 1,
        size: int = 20,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = store.rows(MODULE)
        if keyword:
            rows = [row for row in rows if keyword in str(row.get("记录编号", ""))]
        if status:
            rows = [row for row in rows if row.get("status") == status]
        if channel:
            rows = [row for row in rows if channel in str(row.get("通道编号", ""))]
        total = len(rows)
        start = max(page - 1, 0) * size
        return [self._enrich(row) for row in rows[start:start + size]], total

    def get_entry(self, entry_id: int) -> dict[str, Any] | None:
        row = store.find(MODULE, entry_id)
        if row is None:
            return None
        return self._enrich(row)

    def create_entry(self, values: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
        missing = [field for field in REQUIRED_FIELDS if not str(values.get(field) or "").strip()]
        if missing:
            return None, missing
        rows = store.rows(MODULE)
        entry = {"id": max((int(row.get("id", 0)) for row in rows), default=0) + 1}
        entry.update({field: values.get(field) for field in REQUIRED_FIELDS})
        entry["status"] = STATUS_ORDER[0]
        entry["pending"] = True
        entry["abnormal"] = False
        rows.append(entry)
        return entry, []

    def run_action(self, entry_id: int, action: str) -> tuple[dict[str, Any] | None, str]:
        entry = store.find(MODULE, entry_id)
        if entry is None:
            return None, f"变更记录 {entry_id} 不存在或已归档"
        if action not in ACTION_RULES:
            return None, f"动作「{action}」不属于变更审计可执行范围"
        target = ACTION_RULES[action]
        if target not in STATUS_ORDER:
            return None, f"目标状态「{target}」不在允许的状态序列里"
        entry["status"] = target
        entry["pending"] = target != STATUS_ORDER[-1]
        entry["abnormal"] = action in NEGATIVE_ACTIONS
        return entry, f"变更记录已{action}"

    def record_sync_resume(self, audit_fields: dict[str, Any]) -> dict[str, Any]:
        """把一轮续传结论落成审计条目：快照随条目冻结，之后不再被通道状态改写。"""
        rows = store.rows(MODULE)
        entry = {"id": max((int(row.get("id", 0)) for row in rows), default=0) + 1}
        entry["记录编号"] = f"AUDI-{entry['id']:04d}"
        entry.update(audit_fields)
        entry["操作时间"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        entry["status"] = "已记录"
        entry["pending"] = True
        entry["abnormal"] = bool(audit_fields.get("失败区间") not in (None, "", "无"))
        rows.append(entry)
        return dict(entry)

    @staticmethod
    def _enrich(row: dict[str, Any]) -> dict[str, Any]:
        """同步类审计条目附上冻结的续传快照；若正是通道当前轮次，标记与现断点一致。"""
        item = dict(row)
        snapshot = item.get("resume_snapshot")
        if isinstance(snapshot, dict):
            item["resume_live"] = (
                registry.current_seq(int(snapshot.get("channel_id", 0))) == int(snapshot.get("channel_seq", -1))
            )
        return item


def record_sync_resume(audit_fields: dict[str, Any]) -> dict[str, Any]:
    """模块级入口：同步模块提交续传结论时调用，避免两个服务互相持有实例。"""
    return AuditlogService().record_sync_resume(audit_fields)
