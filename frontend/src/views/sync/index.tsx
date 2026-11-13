import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { request } from '@/api/client'
import ResumeSnapshotPanel, { type ResumeSnapshot } from '@/components/ResumeSnapshotPanel'

const ENDPOINT = '/api/sync'
const columns = [
  "通道编号",
  "来源表名",
  "目标表名",
  "同步方式",
  "延迟秒数",
  "并发度",
  "断点续传",
  "最后同步时间"
]
const actions = [
  "提交通道审批",
  "启用通道",
  "停用通道"
]
const statuses = [
  "草稿",
  "通道审批中",
  "已启用",
  "已停用"
]
const stats = [
  {
    "label": "同步通道总数",
    "value": 0
  },
  {
    "label": "已启用通道",
    "value": 0
  },
  {
    "label": "通道审批中",
    "value": 0
  }
]

type ResumeSummary = {
  ack_lsn: string
  pending_range: [string, string] | null
  decision: string
  lag_ms: number
}

type Row = Record<string, unknown> & { id: number; resume?: ResumeSummary | null }

type ResumeDetail = {
  channel_id: number
  通道编号: string
  同步方式: string
  snapshot: ResumeSnapshot | null
  defaults: {
    source_watermark: string
    ack_lsn: string
    max_lag_ms: number
    schema_version: string
    suggested_token: string
  }
}

type CommitForm = {
  source_watermark: string
  ack_lsn: string
  lag_ms: string
  schema_version: string
  failed_ranges: string
  idempotency_token: string
}

/** 把「09:30~09:35, 09:55~09:58」解析成区间数组，交给后端判定失败区间。 */
function parseRangesInput(text: string): [string, string][] {
  return text
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [start, end] = item.split(/~|～/).map((part) => part.trim())
      return [start ?? '', end ?? ''] as [string, string]
    })
}

export default function SyncView() {
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [detail, setDetail] = useState<ResumeDetail | null>(null)
  const [form, setForm] = useState<CommitForm | null>(null)
  const filterFields = useMemo(() => columns.slice(0, 3), [])
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const reload = useCallback(async () => {
    setErrorMessage('')
    // 通道编号走后端 keyword 过滤，其余条件在返回结果上本地过滤
    const query = new URLSearchParams()
    if (filters['通道编号']) query.set('keyword', filters['通道编号'])
    try {
      const response = await request(`${ENDPOINT}?${query.toString()}`)
      if (!response.ok) {
        throw new Error('同步通道列表读取失败')
      }
      const payload = await response.json()
      let items = (payload.items ?? []) as Row[]
      for (const field of filterFields.slice(1)) {
        const value = filters[field]
        if (value) items = items.filter((row) => String(row[field] ?? '').includes(value))
      }
      setRows(items)
      setTotal(payload.total ?? 0)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '同步通道列表读取失败')
    }
  }, [filters, filterFields])

  useEffect(() => {
    void reload()
  }, [reload])

  // 跨页面联动：从审计详情带 ?channel= 进来时，按通道过滤并直接打开续传详情
  useEffect(() => {
    const channel = searchParams.get('channel')
    if (!channel) return
    setFilters((prev) => ({ ...prev, '通道编号': channel }))
  }, [searchParams])

  useEffect(() => {
    const channel = searchParams.get('channel')
    if (!channel || rows.length === 0) return
    const hit = rows.find((row) => row['通道编号'] === channel)
    if (hit && detail?.通道编号 !== channel) {
      void openDetail(hit)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  async function openDetail(row: Row) {
    setErrorMessage('')
    try {
      const response = await request(`${ENDPOINT}/${row.id}/resume`)
      if (!response.ok) {
        throw new Error('续传结论读取失败')
      }
      const payload = (await response.json()) as ResumeDetail
      setDetail(payload)
      setForm({
        source_watermark: payload.defaults.source_watermark,
        ack_lsn: payload.defaults.ack_lsn,
        lag_ms: '',
        schema_version: payload.defaults.schema_version,
        failed_ranges: '',
        idempotency_token: payload.defaults.suggested_token,
      })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '续传结论读取失败')
    }
  }

  async function runAction(action: string, row: Row) {
    setErrorMessage('')
    try {
      const response = await request(`${ENDPOINT}/${row.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      if (!response.ok) {
        throw new Error('同步通道动作未生效，请稍后重试')
      }
      await reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '同步通道操作失败')
    }
  }

  async function commitResume(tokenOverride?: string) {
    if (!detail || !form) return
    setErrorMessage('')
    setNotice('')
    try {
      const response = await request(`${ENDPOINT}/${detail.channel_id}/resume/commit`, {
        method: 'POST',
        body: JSON.stringify({
          values: {
            idempotency_token: tokenOverride ?? form.idempotency_token,
            source_watermark: form.source_watermark,
            ack_lsn: form.ack_lsn,
            lag_ms: Number(form.lag_ms || 0),
            schema_version: form.schema_version,
            failed_ranges: parseRangesInput(form.failed_ranges),
          },
        }),
      })
      const payload = await response.json()
      if (!response.ok || !payload.ok) {
        throw new Error(payload.message ?? '续传提交未生效，请稍后重试')
      }
      setNotice(payload.message)
      await reload()
      await openDetail({ id: detail.channel_id } as Row)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '续传提交失败')
    }
  }

  function renderResume(row: Row): string {
    const resume = row.resume
    if (!resume) return '尚未建立断点'
    const pending = resume.pending_range ? `，待补 ${resume.pending_range[0]}~${resume.pending_range[1]}` : ''
    return `${resume.ack_lsn}（${resume.decision}${pending}）`
  }

  return (
    <section className="page" data-module="sync">
      <header className="page-head">
        <div>
          <h2>同步通道管理</h2>
          <p className="page-desc">管理跨系统或跨环境的数据同步通道，配置同步方式和断点续传策略。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('同步通道登记入口尚未接入审批流')}>
            登记同步通道
          </button>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出同步通道清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); void reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>续传水位</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{String(row[column] ?? '—')}</td>)}
              <td>{renderResume(row)}</td>
              <td className="row-actions">
                <button className="link" type="button" onClick={() => void openDetail(row)}>
                  续传详情
                </button>
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => void runAction(action, row)}>
                    {action}
                  </button>
                ))}
                <button
                  className="link"
                  type="button"
                  onClick={() => navigate(`/auditlog?channel=${encodeURIComponent(String(row['通道编号'] ?? ''))}`)}
                >
                  变更审计
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无同步通道数据，可先登记同步通道</td>
            </tr>
          )}
        </tbody>
      </table>

      {detail && form && (
        <section className="detail-panel">
          <h3>续传详情：{detail.通道编号}（{detail.同步方式}）</h3>
          {detail.snapshot ? (
            <ResumeSnapshotPanel snapshot={detail.snapshot} live />
          ) : (
            <p className="page-desc">该通道尚未建立断点，提交第一轮后将生成续传快照。</p>
          )}

          <form
            className="filter-bar"
            onSubmit={(event) => { event.preventDefault(); void commitResume() }}
          >
            <label className="filter-item">
              <span>源端水位</span>
              <input
                value={form.source_watermark}
                placeholder="如 09:45"
                onChange={(event) => setForm((prev) => prev && { ...prev, source_watermark: event.target.value })}
              />
            </label>
            <label className="filter-item">
              <span>目标确认水位 ack_lsn</span>
              <input
                value={form.ack_lsn}
                placeholder="如 09:28"
                onChange={(event) => setForm((prev) => prev && { ...prev, ack_lsn: event.target.value })}
              />
            </label>
            <label className="filter-item">
              <span>当前延迟 lag_ms</span>
              <input
                value={form.lag_ms}
                placeholder={`阈值 ${detail.defaults.max_lag_ms}`}
                onChange={(event) => setForm((prev) => prev && { ...prev, lag_ms: event.target.value })}
              />
            </label>
            <label className="filter-item">
              <span>schema 版本</span>
              <input
                value={form.schema_version}
                onChange={(event) => setForm((prev) => prev && { ...prev, schema_version: event.target.value })}
              />
            </label>
            <label className="filter-item">
              <span>失败区间（可选，如 09:36~09:40）</span>
              <input
                value={form.failed_ranges}
                onChange={(event) => setForm((prev) => prev && { ...prev, failed_ranges: event.target.value })}
              />
            </label>
            <label className="filter-item">
              <span>幂等令牌</span>
              <input
                value={form.idempotency_token}
                onChange={(event) => setForm((prev) => prev && { ...prev, idempotency_token: event.target.value })}
              />
            </label>
            <button className="btn primary" type="submit">提交本轮续传</button>
            {detail.snapshot && (
              <button
                className="btn ghost"
                type="button"
                onClick={() => void commitResume(detail.snapshot?.idempotency_token)}
              >
                重试上一令牌（验证去重）
              </button>
            )}
          </form>
          {notice && <p className="notice-text">{notice}</p>}
        </section>
      )}

      <footer className="page-foot">
        <span>共 {total} 条同步通道记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
