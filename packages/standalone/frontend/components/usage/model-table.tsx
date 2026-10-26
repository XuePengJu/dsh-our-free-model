/**
 * 「按模型统计」表 —— 原 `usage.tsx` 里那张表的**原样迁移**。
 *
 * ⚠️ e2e 依赖（`scripts/standalone-react-ui-test.mjs`）：
 *   `data-testid="usage-model-count"`、`data-usage-model="<模型 id>"`、
 *   搜索框 `aria-label="搜索统计模型"`、排序 `aria-label="统计模型排序"`、
 *   翻页钮 `aria-label="上一页统计模型" / "下一页统计模型"`。
 *   **一个字都不许改，也不许删** —— 改这个文件前先跑一遍 `npm run test:standalone`。
 *
 * 筛选/排序/分页逻辑仍由 `usage-data.mjs` 的 `usageModels()` 负责（在 `usage.tsx` 里调用），
 * 本组件只接收算好的 `rows` / `total` / `pages` 并回调，避免两处各写一份口径。
 */
import { Activity, ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import { Badge, Button, Card, Input } from '../ui'
import type { UsageModel, UsagePeriod } from '../../types'

const number = (value: number): string => new Intl.NumberFormat('zh-CN').format(value)

/** 缺失 ≠ 0：没有实测样本时显示 `—`。 */
const measured = (value?: number | null): string => (value != null && Number.isFinite(value) ? number(value) : '—')

interface ModelTableProps {
  /** 当前页的行（已筛选、已排序、已分页）。 */
  rows: UsageModel[]
  /** 命中筛选条件的总行数。 */
  total: number
  /** 总页数。 */
  pages: number
  /** 当前页（从 1 起）。 */
  page: number
  /** 该口径下的模型总数（用于「x / y 个模型」的分母）。 */
  modelTotal: number
  period: UsagePeriod
  /** 口径词（`今日` / `本周` / `本月`），用于计数文案。 */
  periodWord: string
  /** 该口径下「用户回合」不可用（旧记录没有回合维度）时为 true，三列显示 `—`。 */
  turnsUnavailable: boolean
  search: string
  sort: string
  onSearch: (value: string) => void
  onSort: (value: string) => void
  onPage: (page: number) => void
  /** 空态标题 / 说明（文案由页面统一给，避免两处各写一份）。 */
  emptyTitle: string
  emptyDesc: string
}

/**
 * 按模型统计表。
 *
 * @param rows 当前页数据；`total === 0` 时渲染空态
 * @param turnsUnavailable 为 true 时「用户回合 / 失败回合 / 恢复回合」三列显示 `—`
 */
export function ModelTable({
  rows,
  total,
  pages,
  page,
  modelTotal,
  period,
  periodWord,
  turnsUnavailable,
  search,
  sort,
  onSearch,
  onSort,
  onPage,
  emptyTitle,
  emptyDesc,
}: ModelTableProps) {
  const badgeText = period === 'all' ? `${number(modelTotal)} 个模型` : `${periodWord} ${number(modelTotal)} 个模型有活动`
  return (
    <Card className="usage-model-panel">
      <div className="card-heading">
        <div>
          <h2>按模型统计</h2>
          <p>{period === 'all' ? '累计记录 · 每页最多 20 个模型' : '所选周期记录 · 每页最多 20 个模型'}</p>
        </div>
        <Badge>{badgeText}</Badge>
      </div>
      <div className="usage-model-filters">
        <div className="usage-model-search">
          <Search size={16} />
          <Input
            type="search"
            aria-label="搜索统计模型"
            placeholder="搜索模型名称或 ID…"
            value={search}
            onChange={event => onSearch(event.target.value)}
          />
        </div>
        <select aria-label="统计模型排序" value={sort} onChange={event => onSort(event.target.value)}>
          <option value="calls">物理请求最多</option>
          <option value="tokens">Token 用量最多</option>
          <option value="failedTurns">失败回合最多</option>
          <option value="name">模型名称</option>
        </select>
        {search && (
          <Button variant="ghost" onClick={() => onSearch('')}>
            <X size={14} />清空搜索
          </Button>
        )}
      </div>
      {total ? (
        <>
          <p className="usage-scroll-hint">左右滑动查看完整统计。</p>
          <div className="usage-model-scroll" tabIndex={0} role="region" aria-label="按模型统计，可横向滚动">
            <table className="usage-model-table">
              <thead>
                <tr>
                  <th scope="col">模型 / ID</th>
                  <th scope="col">用户回合</th>
                  <th scope="col">物理请求</th>
                  <th scope="col">输入 Token</th>
                  <th scope="col">输出 Token</th>
                  <th scope="col">失败回合</th>
                  <th scope="col">恢复回合</th>
                  <th scope="col">
                    首字延迟
                    {period === 'all' ? <span className="usage-col-hint" title="基于保留期内样本统计，与左侧累计 Token 口径不同。">ⓘ</span> : null}
                  </th>
                  <th scope="col">
                    生成速度
                    {period === 'all' ? <span className="usage-col-hint" title="基于保留期内样本统计，与左侧累计 Token 口径不同。">ⓘ</span> : null}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(model => (
                  <tr key={model.model} data-usage-model={model.model}>
                    <td><strong>{model.name}</strong><code>{model.model}</code></td>
                    <td>{turnsUnavailable ? '—' : number(model.turns)}</td>
                    <td>{number(model.calls)}<small>失败 {number(model.failed)}</small></td>
                    <td>{number(model.input)}</td>
                    <td>{number(model.output)}</td>
                    <td>{turnsUnavailable ? '—' : number(model.failedTurns)}</td>
                    <td>{turnsUnavailable ? '—' : number(model.recoveredTurns)}</td>
                    <td>{measured(model.avgTtftMs)}<small>ms</small></td>
                    <td>{measured(model.tps)}<small>Token/s</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="usage-empty">
          <Activity size={25} />
          <h3>{emptyTitle}</h3>
          <p>{emptyDesc}</p>
        </div>
      )}
      {/* 规则：计数文字居左归组，翻页改紧凑图标钮居右（aria-label / title 保留完整文案）。 */}
      <div className="usage-pagination">
        <span data-testid="usage-model-count">
          {number(total)} / {number(modelTotal)} {period === 'all' ? '个模型' : '个有活动的模型'} · 第 {page} / {pages} 页
        </span>
        <div className="usage-pagination-nav">
          <Button
            variant="outline"
            size="icon"
            aria-label="上一页统计模型"
            title="上一页统计模型"
            disabled={page === 1}
            onClick={() => onPage(page - 1)}
          >
            <ChevronLeft size={15} />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="下一页统计模型"
            title="下一页统计模型"
            disabled={page === pages}
            onClick={() => onPage(page + 1)}
          >
            <ChevronRight size={15} />
          </Button>
        </div>
      </div>
    </Card>
  )
}
