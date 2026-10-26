/**
 * 渠道 · 账号明细表。
 *
 * 两个视图（工具栏只有这两组切换，**没有导出按钮**——老板已明确否决）：
 * - 按渠道：一行 = channel|provider，账号/模型取该行最大者；
 * - 按模型：跨账号聚合，均值一律「先加总再除」，绝不「平均的平均」。
 *
 * 底部合计行承载「累计」口径（老板已确认：累计不做独立 KPI 卡）。
 */
import { useState } from 'react'
import type { ChannelModelRow, ChannelRow, ChannelTableMode, LedgerTotals } from '../../types'

const numberFormat = new Intl.NumberFormat('zh-CN')

/** 紧凑格式：`1.2M` / `28.5K` / `742`；明细表列宽有限，不做千分位长数字。 */
const compact = (value: number): string => {
  const rounded = Math.round(value || 0)
  if (rounded >= 1e6) return `${Number((rounded / 1e6).toFixed(1))}M`
  if (rounded >= 1e4) return `${Number((rounded / 1e3).toFixed(1))}K`
  return numberFormat.format(rounded)
}

/** 缺失 ≠ 0：没有实测样本时显示 `—`。 */
const measured = (value?: number | null): string => (value == null || !Number.isFinite(value) ? '—' : numberFormat.format(Math.round(value)))

/** 速度迷你条：以 95 tok/s 为满格（原型同口径）。 */
const speedPercent = (tps?: number): number => (tps == null ? 0 : Math.min(100, Math.round((tps / 95) * 100)))

/** 缓存命中率 = 读缓存 /（输入 + 读缓存），无输入时为 0。 */
const cacheRate = (totals: LedgerTotals): number => {
  const base = totals.inputTokens + totals.cacheReadTokens
  return base > 0 ? Math.round((totals.cacheReadTokens / base) * 100) : 0
}

interface ChannelTableProps {
  /** 「按渠道」视图的行。 */
  channels: ChannelRow[]
  /** 「按模型」视图的行。 */
  models: ChannelModelRow[]
  /** 表格底部合计行用的小计（当前档位口径，如「近 7 天合计」）。 */
  totals: LedgerTotals
  /** 受控视图；不传则由组件内部持有（纯 UI 状态，不上提）。 */
  mode?: ChannelTableMode
  onModeChange?: (mode: ChannelTableMode) => void
  /** 面板副标题里的口径说明（`今日 · 按渠道聚合`）。 */
  scopeLabel?: string
  /** 渠道服务未连接：只影响本区块，不白屏。 */
  unavailable?: boolean
  /** 不可用的具体文案（503「渠道服务未连接」/ 502「读取失败」/ 超时，三种说法不同）。 */
  unavailableText?: string
  /** 首屏加载中。 */
  loading?: boolean
  /**
   * 空态文案。
   *
   * ⚠️ 必须由调用方给：账本的空有**两种**截然不同的含义 ——
   * 「这个账号从来没跑过请求」和「账本有记录但这一档没有」（后者要引导切到「全部」）。
   * 组件自己猜不出来，写死一句会误导用户。
   */
  emptyText?: string
  /** 合计行前缀（`今日合计` / `累计（90 天）`）。 */
  totalsLabel?: string
  /**
   * 「速度」「首字」两列的口径提示（hover 到 ⓘ 上显示）。
   *
   * 这两列的数值来自**明细样本**（内存最多 500 条），而同一行的计数与 Token
   * 来自落盘日聚合（全量）。两个口径并排出现在一张表里，不在列头说清就会
   * 被读成同一回事 —— 那正是「全部」档看起来少 34 倍的翻版。
   */
  rateHint?: string
}

/**
 * 渠道 · 账号明细表。
 *
 * @param channels 按渠道摊平后的行
 * @param models 按模型跨账号聚合后的行
 * @param totals 合计行（累计口径）
 */
export function ChannelTable({
  channels,
  models,
  totals,
  mode,
  onModeChange,
  scopeLabel = '今日 · 按渠道聚合',
  unavailable = false,
  unavailableText,
  loading = false,
  emptyText,
  totalsLabel = '累计（90 天）',
  rateHint = '最近实测样本，非区间全量平均',
}: ChannelTableProps) {
  const [internalMode, setInternalMode] = useState<ChannelTableMode>('channel')
  const active = mode ?? internalMode
  const switchMode = (next: ChannelTableMode): void => {
    setInternalMode(next)
    onModeChange?.(next)
  }

  const rows = active === 'channel' ? channels : models
  const empty = rows.length === 0

  return (
    <section className="r-panel" data-testid="usage-channel-table">
      <div className="r-panel-head">
        <h3>渠道 · 账号明细</h3>
        <span className="r-panel-sub">{active === 'channel' ? scopeLabel : `${scopeLabel.replace('按渠道', '按模型')}`}</span>
        <div className="r-tool">
          <div className="r-seg" role="group" aria-label="明细表视图">
            <button type="button" aria-pressed={active === 'channel'} onClick={() => switchMode('channel')}>按渠道</button>
            <button type="button" aria-pressed={active === 'model'} onClick={() => switchMode('model')}>按模型</button>
          </div>
        </div>
      </div>

      {loading && <div className="r-table-empty" role="status">正在读取渠道账本…</div>}
      {!loading && unavailable && (
        <div className="r-table-empty" role="status">
          {unavailableText ?? '渠道服务未连接，明细暂不可用。用量与趋势（上方区块）不受影响。'}
        </div>
      )}
      {!loading && !unavailable && empty && (
        <div className="r-table-empty" role="status">
          {emptyText ?? (active === 'channel' ? '所选时段还没有渠道请求记录。' : '所选时段还没有模型调用记录。')}
        </div>
      )}

      {!loading && !unavailable && !empty && (
        <div className="r-tbl-scroll">
          <table className="r-table">
            <thead>
              <tr>
                {active === 'channel' ? (
                  <>
                    <th scope="col">渠道</th>
                    <th scope="col">账号</th>
                    <th scope="col">主力模型</th>
                  </>
                ) : (
                  <>
                    <th scope="col">模型</th>
                    <th scope="col">渠道</th>
                    <th scope="col">账号</th>
                  </>
                )}
                <th scope="col">请求</th>
                <th scope="col">失败</th>
                <th scope="col">
                  速度
                  <span className="r-th-info" role="img" aria-label={rateHint} title={rateHint}>ⓘ</span>
                </th>
                <th scope="col">
                  首字
                  <span className="r-th-info" role="img" aria-label={rateHint} title={rateHint}>ⓘ</span>
                </th>
                <th scope="col">输入</th>
                <th scope="col">输出</th>
                <th scope="col">缓存命中</th>
                <th scope="col">占比</th>
              </tr>
            </thead>
            <tbody>
              {active === 'channel'
                ? channels.map(row => (
                  <tr key={row.key}>
                    <td>
                      <div className="r-cell">
                        <span className="r-av" style={{ background: row.accent }} aria-hidden="true">{row.providerShort}</span>
                        {/* 展示名（`WorkBuddy 国际版`）；id 留在 title 里便于对日志 */}
                        <span className="r-nm" title={row.provider}>{row.providerName || row.provider}</span>
                      </div>
                    </td>
                    <td><div className="r-cell"><span className="r-acct">{row.topAccount || '未归属'}</span></div></td>
                    <td>
                      <div className="r-cell">
                        <span className="r-md" title={`${row.topModels.join(' / ')} — 主力模型按区间 token 最多，最后使用见小字`}>
                          {row.topModel}
                          {row.recentModel != null && row.recentModel !== row.topModel && (
                            <span className="r-md-recent">最近 {row.recentModel}</span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td><div className="r-cell is-right"><span className="r-mono is-b">{numberFormat.format(row.totals.requests)}</span></div></td>
                    <td><div className="r-cell is-right"><span className={`r-mono${row.totals.errors > 0 ? ' is-bad' : ''}`}>{row.totals.errors > 0 ? numberFormat.format(row.totals.errors) : '—'}</span></div></td>
                    <td>
                      <div className="r-cell is-right">
                        <div className="r-minispeed">
                          <div className="r-track"><i style={{ width: `${speedPercent(row.totals.avgTps)}%` }} /></div>
                          <span className="r-mono is-b is-ok">{row.totals.avgTps == null ? '—' : row.totals.avgTps.toFixed(1)}</span>
                        </div>
                      </div>
                    </td>
                    <td><div className="r-cell is-right"><span className="r-mono">{row.totals.avgTtftMs == null ? '—' : `${measured(row.totals.avgTtftMs)} ms`}</span></div></td>
                    <td><div className="r-cell is-right"><span className="r-mono">{compact(row.totals.inputTokens)}</span></div></td>
                    <td><div className="r-cell is-right"><span className="r-mono">{compact(row.totals.outputTokens)}</span></div></td>
                    <td><div className="r-cell is-right"><span className="r-mono">{cacheRate(row.totals)}%</span></div></td>
                    <td>
                      <div className="r-cell is-right">
                        <div className="r-share">
                          <div className="r-track"><i style={{ width: `${row.share}%`, background: row.accent }} /></div>
                          <b>{row.share}%</b>
                        </div>
                      </div>
                    </td>
                  </tr>
                ))
                : models.map(row => (
                  <tr key={row.key}>
                    <td><div className="r-cell"><span className="r-md" title={row.model}>{row.model}</span></div></td>
                    <td><div className="r-cell"><span className="r-nm">{row.providers}</span></div></td>
                    <td><div className="r-cell"><span className="r-nm">{row.accounts}</span></div></td>
                    <td><div className="r-cell is-right"><span className="r-mono is-b">{numberFormat.format(row.totals.requests)}</span></div></td>
                    <td><div className="r-cell is-right"><span className={`r-mono${row.totals.errors > 0 ? ' is-bad' : ''}`}>{row.totals.errors > 0 ? numberFormat.format(row.totals.errors) : '—'}</span></div></td>
                    <td>
                      <div className="r-cell is-right">
                        <div className="r-minispeed">
                          <div className="r-track"><i style={{ width: `${speedPercent(row.totals.avgTps)}%` }} /></div>
                          <span className="r-mono is-b is-ok">{row.totals.avgTps == null ? '—' : row.totals.avgTps.toFixed(1)}</span>
                        </div>
                      </div>
                    </td>
                    <td><div className="r-cell is-right"><span className="r-mono">{row.totals.avgTtftMs == null ? '—' : `${measured(row.totals.avgTtftMs)} ms`}</span></div></td>
                    <td><div className="r-cell is-right"><span className="r-mono">{compact(row.totals.inputTokens)}</span></div></td>
                    <td><div className="r-cell is-right"><span className="r-mono">{compact(row.totals.outputTokens)}</span></div></td>
                    <td><div className="r-cell is-right"><span className="r-mono">{cacheRate(row.totals)}%</span></div></td>
                    <td>
                      <div className="r-cell is-right">
                        <div className="r-share">
                          <div className="r-track"><i style={{ width: `${row.share}%` }} /></div>
                          <b>{row.share}%</b>
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
            {/* 合计行：当前档位的小计口径，弥补「累计 Token 不做独立卡」的信息缺口 */}
            <tfoot>
              <tr>
                <td colSpan={3}>{totalsLabel} · {numberFormat.format(totals.requests)} 次请求</td>
                <td><div className="r-cell is-right"><span className="r-mono is-b">{numberFormat.format(totals.requests)}</span></div></td>
                <td><div className="r-cell is-right"><span className="r-mono">{numberFormat.format(totals.errors)}</span></div></td>
                <td><div className="r-cell is-right"><span className="r-mono">{totals.avgTps == null ? '—' : totals.avgTps.toFixed(1)}</span></div></td>
                <td><div className="r-cell is-right"><span className="r-mono">{totals.avgTtftMs == null ? '—' : `${measured(totals.avgTtftMs)} ms`}</span></div></td>
                <td><div className="r-cell is-right"><span className="r-mono">{compact(totals.inputTokens)}</span></div></td>
                <td><div className="r-cell is-right"><span className="r-mono">{compact(totals.outputTokens)}</span></div></td>
                <td><div className="r-cell is-right"><span className="r-mono">{cacheRate(totals)}%</span></div></td>
                <td><div className="r-cell is-right"><span className="r-mono">—</span></div></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  )
}
