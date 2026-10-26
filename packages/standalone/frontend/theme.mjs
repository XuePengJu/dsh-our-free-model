// 由本地外部模块初始化主题，遵守管理页禁止内联脚本的 CSP。
// 三档：light（白天）/ dark（晚上）/ auto（按时间表自动，默认档）。
// localStorage 'ofm-theme' 存档位；历史值只有 light/dark，天然映射为手动档，没存过即 auto。
// 时间表：19:00–07:00 夜间主题，其余浅色；每 30 秒自检一次，跨档静默切换（不播扩散动效）。
let saved
try { saved = localStorage.getItem('ofm-theme') } catch {
  // 存储不可用时仍可按默认主题展示页面。
}
const explicit = saved === 'light' || saved === 'dark'
const isNight = () => { const hour = new Date().getHours(); return hour >= 19 || hour < 7 }
const apply = () => {
  document.documentElement.dataset.theme = explicit ? saved : (isNight() ? 'dark' : 'light')
}
apply()
// 自动档下，React 挂载前跨档（如 19:00 整）也要能换（挂载后由 ThemeSwitch 接管同款定时器）。
let ticker = null
if (!explicit) ticker = setInterval(apply, 30000)
// React 挂载后必须停掉这个模块级定时器，否则两条逻辑会打架：用户在页内把主题从
// 「自动」切到「晚上」后，这里的 `apply` 仍用**加载时快照**的 `explicit=false` 每 30 秒
// 重写一次 data-theme——白天会把「晚上」覆盖回 light（见 2026-10-26 的 bug）。
// 停掉后主题只由 shell.tsx 的 useTheme 统一管，它自己有 auto 档的同款 30 秒定时器。
export function stopThemeTicker() {
  if (ticker !== null) { clearInterval(ticker); ticker = null }
}
