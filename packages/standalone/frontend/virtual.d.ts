declare module 'ofm-provider-list' {
  export interface Provider {
    id: string; name: string; org: string; accent: string; note: string; login: string
    /** 渠道归属地区：只有国内 / 国外两档，用于左列表的地区筛选。 */
    region: 'cn' | 'global'
    /** 积分方式，多值：Loomy 既每日送也注册送，所以不能压成单值。 */
    creditModes: ('daily' | 'onboarding' | 'quota' | 'none')[]
  }
  export const providers: Provider[]
}
declare module 'ofm-shared-client' {
  // 渠道页面来自未类型化的原插件，通过构建适配导出。
  export const shared: Record<string, any>
}
