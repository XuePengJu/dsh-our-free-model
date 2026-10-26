/**
 * 降级链清单。
 *
 * 只读展示 + 一个跳转出口（「管理降级链」→ `host.navigate('combos')`）；
 * 本页不内嵌编辑（方案附录 A.2：原型里该按钮是画了没连线的占位，落地只做跳转）。
 */
import { Fragment } from 'react'
import { Settings2 } from 'lucide-react'
import type { ChainSummary } from '../../types'

const numberFormat = new Intl.NumberFormat('zh-CN')

interface ChainListProps {
  /** 已按展示顺序排好的链。 */
  chains: ChainSummary[]
  /** 点「管理降级链」时跳到组合页；不传则不渲染该按钮。 */
  onManage?: () => void
  /** 正在使用的链 id（高亮）。 */
  activeChainId?: string
}

/**
 * 降级链清单。
 *
 * @param chains 每行一条链，成员按尝试顺序排列
 * @param onManage 跳转出口；缺省时按钮不渲染
 */
export function ChainList({ chains, onManage, activeChainId }: ChainListProps) {
  return (
    <section className="r-panel">
      <div className="r-panel-head">
        <h3>降级链</h3>
        <span className="r-panel-sub">模型请求先在这里被决定去向</span>
        {onManage && (
          <div className="r-tool">
            <button type="button" className="r-ghost" onClick={() => onManage()}>
              <Settings2 size={11} aria-hidden="true" />
              管理降级链
            </button>
          </div>
        )}
      </div>
      {chains.length === 0 ? (
        <div className="r-table-empty" role="status">还没有降级链配置。在「模型组」里建一条后，请求会依次尝试链上的候选。</div>
      ) : (
        <div className="r-combo-list">
          {chains.map(chain => (
            <div className="r-combo-row" key={chain.comboId}>
              <div className="r-combo-name">
                <b>{chain.name}</b>
                <code>{chain.comboId}</code>
              </div>
              <div className="r-members">
                {chain.members.map((member, index) => (
                  <Fragment key={`${chain.comboId}-${member.provider}-${member.model}`}>
                    {index > 0 && <span className="r-arrow" aria-hidden="true">→</span>}
                    <span className="r-mchip" title={`${member.providerName} · ${member.model}`}>
                      <span className="r-pt" style={{ background: member.accent }} />
                      {member.providerName}
                    </span>
                  </Fragment>
                ))}
              </div>
              <div className="r-combo-right">
                <span className={`r-strategy${chain.strategy === 'round-robin' ? ' is-rr' : ''}`}>{chain.strategyLabel}</span>
                <span className="r-cnt">
                  {chain.requests == null ? '—' : numberFormat.format(chain.requests)} 次请求
                  {activeChainId === chain.comboId ? ' · 在用' : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
