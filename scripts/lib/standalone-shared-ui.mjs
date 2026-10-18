/** 仅转换独立端承载；渠道业务仍来自原插件页面。 */
import fs from 'node:fs'
import vm from 'node:vm'
let source = fs.readFileSync(new URL('../../client.js', import.meta.url), 'utf8')
function replaceOnce(from, to) {
  if (source.split(from).length !== 2) throw new Error(`共享页面替换位置改变：${from.slice(0, 90)}`)
  source = source.replace(from, to)
}
const anchor = '    exports.apply = apply'
if (source.split(anchor).length !== 2) throw new Error('共享页面导出位置改变')
source = source.replace(anchor, "    exports.standalone = { ChannelsPage, ChannelCard, EacAuth, useEacLogin, DICT, CSS, Tank, usePool, poolReading, capacityText, CHANNEL_PROVIDERS, LedgerPage, LogsPage }\n" + anchor)
const api = "try { return new URL('api/our-free-model', document.baseURI).pathname } catch { return '/api/our-free-model' }"
if (source.split(api).length !== 2) throw new Error('共享页面 API 位置改变')
source = source.replace(api, "return '/api/management'")
replaceOnce("api('/pool', { timeout: 25_000 })", "api('/eac/pool', { timeout: 25_000 })")
// 原页面 POST 空 body；独立管理接口要求 JSON 对象。
replaceOnce("...body === undefined ? {} : { body: JSON.stringify(body) },", "body: JSON.stringify(body ?? {}),")
replaceOnce("h(PageHero, { t, titleKey: 'dash.title', subKey: 'dash.sub' },",
  "h(PageHero, { title: t('dash.title'), sub: t('dash.sub') },")
replaceOnce("'chan.sub': '把各家的免费额度接进来：登录一次，模型就出现在对话框的模型选择器里。凭据只写入本机凭据库，页面永远拿不到明文。',",
  "'chan.sub': '登录各家的账号后，通过同一个 API 地址接入免费额度。凭据保存在本机；账号管理页面不显示明文，导出备份包含凭据。',")
let record
vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { record = value } } } })
const shared = record.factory(() => ({})).standalone
const css = shared.CSS + `
.ofm_root{
 max-width:none;
}
.ofm_root button,.ofm_root input,.ofm_root select{font-family:inherit}
.ofm_root img{max-width:100%}
.ofm_root input,.ofm_root select{max-width:100%;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:white;color:inherit}
.ofm_root input[type=checkbox]{padding:0}
/* 运行日志：点击行展开请求/返回摘要 */
.ofm_logrow{cursor:pointer}
.ofm_logrow:active td{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent)}
.ofm_logdetail-row td{padding:0}
.ofm_logdetail-row:hover td{background:transparent}
.ofm_logdetail{display:flex;flex-direction:column;gap:10px;padding:12px 14px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);border-left:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);animation:ofm_logdetail-in .18s ease}
@keyframes ofm_logdetail-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
.ofm_logdetail-block{display:flex;flex-direction:column;gap:3px;min-width:0}
.ofm_logdetail-label{font-size:10px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.ofm_logdetail p{margin:0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary);word-break:break-all;white-space:pre-wrap}
/* 运行日志：底部翻页行（左翻页、右每页条数下拉） */
.ofm_logpager{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;flex-wrap:wrap}
.ofm_logpager-nav{display:flex;align-items:center;gap:10px}
.ofm_logpager-size{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ofm_logpager-size select{padding:4px 8px;font-size:12px;border-radius:7px;max-width:none}
`

export function standaloneSharedUi() {
  return { name: '独立端共享渠道',
    resolveId(id) {
      if (id === 'ofm-shared-client' || id === 'ofm-provider-list') return '\0' + id
      if (id === 'ofm-shared-styles.css') return '\0' + id
    },
    load(id) {
      if (id === '\0ofm-shared-client') return `import * as React from 'react'; export const shared = (${record.factory.toString()})(() => React).standalone;`
      if (id === '\0ofm-shared-styles.css') return css
      if (id === '\0ofm-provider-list') return `export const providers = ${JSON.stringify(shared.CHANNEL_PROVIDERS)}`
    },
  }
}
