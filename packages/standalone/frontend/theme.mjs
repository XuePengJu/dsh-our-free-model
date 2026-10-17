// 由本地外部模块初始化主题，遵守管理页禁止内联脚本的 CSP。
// 默认夜间（暗夜靛蓝）：仅在用户手动切换过（localStorage 有记录）时才用其选择。
let saved
try { saved = localStorage.getItem('ofm-theme') } catch {
  // 存储不可用时仍可按默认主题展示页面。
}
document.documentElement.dataset.theme = saved === 'light' ? 'light' : 'dark'
