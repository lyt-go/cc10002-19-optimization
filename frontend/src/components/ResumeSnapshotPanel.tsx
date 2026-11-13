/** 续传快照面板：同步详情与变更审计详情共用的展示组件，两边渲染同一份续传结论。 */

export type ResumeSnapshot = {
  channel_seq: number
  source_watermark: string
  ack_lsn: string
  lag_ms: number
  max_lag_ms: number
  pending_range: [string, string] | null
  idempotency_token: string
  ack_summary: string
  decision: string
  decision_reason: string
  sync_mode: string
  schema_version: string
  confirmed_ranges: [string, string][]
  failed_ranges: [string, string][]
  updated_at: string
}

function renderRange(range: [string, string] | null): string {
  return range ? `${range[0]} ~ ${range[1]}` : '无'
}

function renderRanges(ranges: [string, string][]): string {
  return ranges.length ? ranges.map(([start, end]) => `${start}~${end}`).join('、') : '无'
}

export default function ResumeSnapshotPanel({ snapshot, live }: { snapshot: ResumeSnapshot; live?: boolean }) {
  return (
    <div className="resume-panel">
      <div className="resume-head">
        <strong>续传结论：{snapshot.decision}</strong>
        {live && <span className="badge">与通道当前断点一致</span>}
      </div>
      <p className="resume-reason">{snapshot.decision_reason}</p>
      <dl className="kv-grid">
        <div><dt>channel_seq</dt><dd>{snapshot.channel_seq}</dd></div>
        <div><dt>ack_lsn（续传水位）</dt><dd>{snapshot.ack_lsn}</dd></div>
        <div><dt>lag_ms</dt><dd>{snapshot.lag_ms}（阈值 {snapshot.max_lag_ms}）</dd></div>
        <div><dt>pending_range</dt><dd>{renderRange(snapshot.pending_range)}</dd></div>
        <div><dt>idempotency_token</dt><dd>{snapshot.idempotency_token}</dd></div>
        <div><dt>源端水位</dt><dd>{snapshot.source_watermark}</dd></div>
        <div><dt>同步方式</dt><dd>{snapshot.sync_mode}</dd></div>
        <div><dt>schema 版本</dt><dd>{snapshot.schema_version}</dd></div>
        <div><dt>已确认区间</dt><dd>{renderRanges(snapshot.confirmed_ranges)}</dd></div>
        <div><dt>失败区间</dt><dd>{renderRanges(snapshot.failed_ranges)}</dd></div>
        <div><dt>更新时间</dt><dd>{snapshot.updated_at}</dd></div>
      </dl>
      <p className="resume-ack">目标端确认摘要：{snapshot.ack_summary}</p>
    </div>
  )
}
