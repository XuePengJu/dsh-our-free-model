// 接入地址来源选择：'page' = 当前访问的域名/IP，'local' = 服务端绑定地址（通常为 127.0.0.1）。
// 选择持久化在 localStorage，跨页面生效——概览「快速接入」卡、模型清单/模型组的
// 接入信息条与「写入 WorkBuddy」按钮都使用同一选择。
// （原「API 接入」页的切换 UI 已随页面下线；saveEndpointOriginChoice 暂留，
//   后续如需在别处恢复切换入口可直接复用。）
export type EndpointOriginChoice = 'page' | 'local'

const STORAGE_KEY = 'ofm:endpoint-origin'

export function loadEndpointOriginChoice(): EndpointOriginChoice {
  try { return localStorage.getItem(STORAGE_KEY) === 'local' ? 'local' : 'page' }
  catch { return 'page' }
}

export function saveEndpointOriginChoice(choice: EndpointOriginChoice): void {
  try { localStorage.setItem(STORAGE_KEY, choice) } catch { /* 隐私模式等场景下静默降级为会话内默认 */ }
}

/** 按当前选择解析实际使用的接入基地址；页面源不是 http(s) 时回退服务端地址。 */
export function resolveEndpointBase(summaryBaseUrl: string): string {
  const page = window.location.origin
  if (loadEndpointOriginChoice() === 'local' || !page.startsWith('http')) return summaryBaseUrl
  return page
}
