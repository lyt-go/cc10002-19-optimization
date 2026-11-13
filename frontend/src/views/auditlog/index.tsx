import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { request } from '@/api/client'
import ResumeSnapshotPanel, { type ResumeSnapshot } from '@/components/ResumeSnapshotPanel'

const ENDPOINT = '/api/auditlog'
const columns = [
  "记录编号",
  "操作表名",
  "变更类型",
  "变更前值",
  "变更后值",
  "操作人",
  "操作时间",
  "变更原因"
]
const actions = [
  "确认记录",
  "提交复核"
]
const statuses = [
  "草稿",
  "已记录",
  "已复核"
]
const stats = [
  {
    "label": "变更记录总数",
    "value": 0
  },
  {
    "label": "已复核记录",
    "value": 0
  },
  {
    "label": "今日变更量",
    "value": 0
  }
]

type Row = Record<string, unknown> & { id: number }

type AuditDetail = Row & {
  resume_snapshot?: ResumeSnapshot
  resume_live?: boolean
}

export default function AuditlogView() {
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [detail, setDetail] = useState<AuditDetail | null>(null)
  const filterFields = useMemo(() => columns.slice(0, 3), [])
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const reload = useCallback(async () => {
    setErrorMessage('')
    // 记录编号走后端 keyword，通道编号走后端 channel（与同步页联动），其余本地过滤
    const query = new URLSearchParams()
    if (filters['记录编号']) query.set('keyword', filters['记录编号'])
    if (filters['通道编号']) query.set('channel', filters['通道编号'])
    try {
      const response = await request(`${ENDPOINT}?${query.toString()}`)
      if (!response.ok) {
        throw new Error('变更记录列表读取失败')
      }
      const payload = await response.json()
      let items = (payload.items ?? []) as Row[]
      for (const field of ['操作表名', '变更类型']) {
        const value = filters[field]
        if (value) items = items.filter((row) => String(row[field] ?? '').includes(value))
      }
      setRows(items)
      setTotal(payload.total ?? 0)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '变更审计列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    void reload()
  }, [reload])

  // 跨页面联动：从同步通道带 ?channel= 进来时，直接按通道过滤续传审计
  useEffect(() => {
    const channel = searchParams.get('channel')
    if (!channel) return
    setFilters((prev) => ({ ...prev, '通道编号': channel }))
  }, [searchParams])

  async function openDetail(row: Row) {
    setErrorMessage('')
    try {
      const response = await request(`${ENDPOINT}/${row.id}`)
      if (!response.ok) {
        throw new Error('变更记录详情读取失败')
      }
      setDetail((await response.json()) as AuditDetail)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '变更记录详情读取失败')
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
        throw new Error('变更审计动作未生效，请稍后重试')
      }
      await reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '变更审计操作失败')
    }
  }

  return (
    <section className="page" data-module="auditlog">
      <header className="page-head">
        <div>
          <h2>变更审计管理</h2>
          <p className="page-desc">记录所有表结构、数据和质量规则的变更历史，支持回溯和合规审计。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('变更记录登记入口尚未接入审批流')}>
            登记变更记录
          </button>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出变更审计清单
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
        <label className="filter-item">
          <span>通道编号</span>
          <input
            value={filters['通道编号'] ?? ''}
            placeholder="按通道编号过滤续传记录"
            onChange={(event) => setFilters((prev) => ({ ...prev, '通道编号': event.target.value }))}
          />
        </label>
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
              <td>{row['续传水位'] ? String(row['续传水位']) : '—'}</td>
              <td className="row-actions">
                <button className="link" type="button" onClick={() => void openDetail(row)}>
                  详情
                </button>
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => void runAction(action, row)}>
                    {action}
                  </button>
                ))}
                {Boolean(row['通道编号']) && (
                  <button
                    className="link"
                    type="button"
                    onClick={() => navigate(`/sync?channel=${encodeURIComponent(String(row['通道编号']))}`)}
                  >
                    同步通道
                  </button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无变更审计数据，可先登记变更记录</td>
            </tr>
          )}
        </tbody>
      </table>

      {detail && (
        <section className="detail-panel">
          <h3>审计详情：{String(detail['记录编号'] ?? '')}</h3>
          <dl className="kv-grid">
            <div><dt>操作表名</dt><dd>{String(detail['操作表名'] ?? '—')}</dd></div>
            <div><dt>变更类型</dt><dd>{String(detail['变更类型'] ?? '—')}</dd></div>
            <div><dt>变更前值</dt><dd>{String(detail['变更前值'] ?? '—')}</dd></div>
            <div><dt>变更后值</dt><dd>{String(detail['变更后值'] ?? '—')}</dd></div>
            <div><dt>失败区间</dt><dd>{String(detail['失败区间'] ?? '—')}</dd></div>
            <div><dt>操作时间</dt><dd>{String(detail['操作时间'] ?? '—')}</dd></div>
          </dl>
          {detail.resume_snapshot && (
            <ResumeSnapshotPanel snapshot={detail.resume_snapshot} live={detail.resume_live} />
          )}
        </section>
      )}

      <footer className="page-foot">
        <span>共 {total} 条变更审计记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
