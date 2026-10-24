/**
 * 「每日到点自动签到」—— 开关、签到时间、当日记录与执行体。
 *
 * ## 它做什么
 *
 * 开关开着时，**每 5 分钟**检查一次「今天（UTC+8）到点了吗、今天签过没有」，
 * 两个条件都满足就串行遍历「账号池里真的有账号的渠道」，逐个调内部
 * `credits.claimAll`；跑完把日期与**逐渠道结果**写进文档 ⇒ **当天不再触发**。
 * 用户手动点「全部渠道签到」不受此限（那是显式操作，永远放行）。
 *
 * ## ⚠️ 2026-10-19 改造：从「启动即签」变成「每天到点签」
 *
 * 原实现**没有时间概念**：进程启动后延迟 30 秒跑一次，靠 `lastDate` 做当日
 * 去重。真实缺口（用户报障）：进程常驻不重启 ⇒ 第二天永远不再签 ——「每日」
 * 实际退化成了「每次启动」。用户的原话是「感觉是手动才领到的」，因为确实只有
 * 手动点才会领。
 *
 * 现在改成「每天 `time`（默认 `10:05`，UTC+8）到点签」，判据三条**同时**满足：
 * `enabled === true`、当前 UTC+8 时刻已过今天的 `time`、`lastDate !== 今天`。
 * 启动时若已经过了今天的设定时间且今天没签过，**立刻补签**（不必等到明天）。
 *
 * ## ⚠️ 开关**默认关闭**（2026-10-19 起；此前是默认打开）
 *
 * 原默认「打开」的依据是用户 2026-10-02 的要求，那条针对的是**每日领取**型
 * 渠道（Qoder 等，不领就白丢额度）。但渠道里还有**注册送积分**类（一次性到账、
 * 没有每日任务）：对它们自动签到只是每轮白发一次上游请求，而「代用户打上游的
 * 写操作」本该由用户显式选择。故默认关闭，打开是显式动作。
 *
 * ⚠️ 判据方向随之**反转**：旧实现是「只有显式 `false` 才算关闭」
 *（`enabled !== false`），新契约是「**只有显式 `true` 才算打开**」。
 * 别照抄旧写法 —— `!== false` 会把「旧文档里没有该字段」判成打开。
 *
 * ## ⚠️ 为什么是「每 5 分钟检查一次」而不是「算到明天 10:05 的一次性长定时器」
 *
 * 一次性长定时器在**笔记本合盖休眠**下必然漂移：`setTimeout(24 小时)` 在合盖
 * 期间不走（或按唤醒后重新计时），醒来时可能已经错过了设定时刻，而长定时器
 * **不会自己补**——于是「今天又没签」。周期检查是**幂等**的：每次醒来都重新
 * 问一遍「现在到点了吗」，最多晚一个周期（5 分钟），且天然处理了「跨天」。
 *
 * 代价是每天 ~288 次空转，全部只是几次算术比较、不发任何请求 —— 相对一轮
 * 十几条串行上游请求可以忽略。周期检查本身也是**幂等**的：`lastDate` 一旦
 * 记成今天，后续每次都被守卫拦下（见 `runIfDue`）。
 *
 * ## 为什么第一次检查要延迟 30 秒
 *
 * 两个理由，任一成立都不该立刻跑：
 * 1. **不跟启动抢资源**：一轮签到是「渠道数 × 账号数」次串行上游请求（反风控
 *    口径，见 `collectCreditBalances` 的顺序查询），启动瞬间打它会拖慢首屏；
 * 2. **等凭据续期先跑一轮**：宿主启动时的续期调度器**本身也要立刻跑一轮**
 *    （见 `index.ts` 的注释：短寿命 provider 的凭据在关机期间早就过期）。
 *    若抢在续期之前签到，过期凭据会让整轮变成失败。
 * 即便如此仍可能抢在续期完成前（多账号时续期本身就要几秒到几十秒），故**再加
 * 一道保险**：整轮跑完**没有任何一条能证明「今天已被处理」**时**不记日期**，
 * 下次启动会重试（见 `shouldMarkToday`）。延迟可用
 * `DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS` 覆盖，`0` 合法（表示立刻跑，单测用它）。
 *
 * ## 什么算「今天已被处理」
 *
 * ⚠️ **不是** `claimed + alreadyClaimed`，而是各渠道用
 * `ClaimOutcome.coversToday` 声明出来的 `summary.coversToday`
 * （真实缺陷，2026-10-02 审查 PR !33 定位：Qoder 活动每日 10:00（UTC+8）才刷新，
 * 上午那轮看到的 `CLAIMED` 属于**昨天**，拿它记账会让当天额度**整天漏领**）。
 *
 * ## 为什么单独一份文档，而不是塞进 ui-preferences.json
 *
 * `ui-preferences.json` 是**同 dsh home、多 profile 共享**的文档，而本仓库写盘
 * 是**整体替换**语义（见 `badge-preferences.ts` 的文件头对 state.json 记过的
 * 同一条理由）。同机上另一条工作区跑着**没有本功能**的旧版本插件时，它保存显示
 * 偏好会把这里的字段静默抹掉 —— 后果是「开关自己关了」或「今天又跑一次」。
 * 独立文档的读写者只有本文件，旧版本代码碰不到它。
 *
 * ## ⚠️ 不支持的渠道怎么判：**不建第二份能力名单**
 *
 * 「哪些渠道能签到」的权威是客户端的 `credits-capabilities.js`（12 个渠道逐项
 * 登记）。在本模块再抄一份必然漂移（本仓库已有「两份名单漂移」的真实缺陷）。
 * 故判据交给 `credits.claimAll` 自己：cline / raccoon / **workbuddy** 三条分支
 * **不发任何上游请求**就返回「不支持每日签到」，本模块把这类错误计为**跳过**，
 * 既不算失败也不重试。
 *
 * ⚠️ 其中 **workbuddy 的那条守卫是本功能先补上的**：此前它会落到 buddy 产品
 * 分支、真去发必然失败的签到请求（客户端从不调用它，是因为能力表写着 false，
 * 所以这个洞一直没被触发）。补上之后，「调用即判定」这条规则才真正安全。
 *
 * ## ⚠️「调用即判定」管不到的一类：签到**有代价**的渠道
 *
 * zcode 有签到，但每次领取都要现场产阿里云 captcha（web 版会拉起 headful
 * Chromium，且阿里云按设备限流 150 次/小时）。「等它返回错误再判定」来不及 ——
 * 代价发生在**调用期间**。故另有一张**排除表** `isAutoCheckinExcluded()`，
 * 在调 `claim` **之前**生效（详见那里的说明与维护口径）。用户仍可手动签到。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { QODER_BILLING_UTC_OFFSET_MS } from './model-queue.js'
import { resolveChannelPackHome } from './channel-pack-store.js'
import { formatClaimGains } from './credits.js'
import { ZCODE } from './zcode-product.js'
import type { BadgeRpcResult } from './usage-badge.js'
import type { RpcCreditsClaimAllResponse, RpcUsageAutoCheckinProviderState, RpcUsageAutoCheckinState } from './types.js'

/** 独立文档的文件名（与 state.json / ui-preferences.json 同目录）。 */
export const AUTO_CHECKIN_FILE = 'auto-checkin.json'

const SCHEMA = 'dsh-codearts-auth/auto-checkin/v1'

/**
 * **单个渠道**的自动签到配置与记账。
 *
 * ## 2026-10-24 改造：全局 → 逐渠道
 *
 * 原模型只有全局 `enabled` / `time`，作用范围写死在 `listProviderIds()` 里
 *（「账号池里所有有账号的渠道」）。用户原话：「我不清楚你要对哪个渠道进行签到」
 * —— 全局开关天然无法表达「这个要签、那个不要」，只能靠用户人工判断。
 * 故改为每个渠道各自一份。
 */
export interface AutoCheckinProviderDoc {
  /**
   * 本渠道是否自动签到。**默认关闭**。
   *
   * ⚠️ 判据是「**只有显式 `true` 才算打开**」—— 与更早的 `enabled !== false`
   * 方向相反。理由：自动签到是代用户打上游的**写操作**，默认该由用户显式开启。
   */
  enabled: boolean
  /**
   * 本渠道每天几点自动签到（`HH:mm`，**UTC+8 时区**）。默认 `'10:05'`。
   *
   * ⚠️ 必须按 UTC+8 解释，不是本机时区 —— 与 `lastDate` 的日界同源（各渠道的
   * 每日额度按服务端账期结算，实测都是 UTC+8）。换算见 {@link utc8MinutesOfDay}。
   *
   * 默认 `'10:05'` 的依据**只对 qodercn 成立**（其每日活动 10:00 UTC+8 才刷新，
   * 见 `QODER_CAMPAIGN_REFRESH_HOUR_UTC8`）。其他渠道的刷新时刻未逐一核实，
   * 这里取它作为「不早于多数渠道刷新点」的保守默认值，用户可自行改。
   */
  time: string
  /** 本渠道上次**完成**自动签到的 UTC+8 日期（`YYYY-MM-DD`）；空串 = 从未跑过。 */
  lastDate: string
  /** 本渠道上次结果摘要（中文短句，如 `2 个 +200积分`）。 */
  lastResult: string
  /** 本渠道上次跑完的时刻（毫秒）；0 = 从未跑过。 */
  lastAt: number
}

/**
 * 文档内容（**逐渠道**）。
 *
 * ## 2026-10-24 改造
 *
 * `providers` 是唯一的配置源。顶层 `channels` / `dismissedRunAt` 是给宿主插件
 * 那版旧 UI（`client.js`）的兼容字段，等它也改成逐渠道后可删。
 *
 * ⚠️ **不再有全局 `enabled` / `time`**：那个语义在新模型下没有对应物。旧文档里
 * 的这两个字段在 {@link sanitizeAutoCheckin} 里被**忽略**（时间作为各渠道的
 * 初始值继承，开关一律按默认关闭），不做「全局 true 展开到所有渠道」——
 * 那会让升级后的用户以为是自己开的。
 */
export interface AutoCheckinDoc {
  /** 逐渠道配置与记账。键是渠道 id。 */
  providers: Record<string, AutoCheckinProviderDoc>
  /**
   * 最近一轮的逐渠道结果文本（顺序即遍历顺序）；空数组 = 没有可展示的信息。
   *
   * ⚠️ 兼容字段：新代码读 `providers[id].lastResult` —— 那里是**每渠道自己**的
   * 结果，不会被别的渠道后跑覆盖。这里只保留给 `client.js` 的汇总展示。
   */
  channels: Array<{ provider: string; text: string }>
  /**
   * 用户点过「关闭」的那一轮（存的是那一刻的 `lastAt`）。
   *
   * ⚠️ 存 `lastAt` 而不是布尔：新一轮跑出来 `lastAt` 变了，状态文字就会**重新出现**
   *（否则用户关过一次以后就再也看不到新的结果）。0 = 未曾关闭过。
   */
  dismissedRunAt: number
  /** 最近一轮跑完的时刻（毫秒）；0 = 从未跑过。兼容字段，供旧 UI 显示时间戳。 */
  lastAt: number
}

/**
 * 默认签到时间（`HH:mm`，UTC+8）。
 *
 * ⚠️ 为什么是 `10:05` 而不是整点 `10:00`：Qoder 的活动**10:00 才刷新**，整点
 * 那一刻服务端可能还在切换（我们实测到过刷新后几秒内仍返回昨天轮次）。留 5 分钟
 * 抖动余量，又不至于晚到让用户白天看不到签到结果。
 */
export const DEFAULT_AUTO_CHECKIN_TIME = '10:05'

/** 默认：**无任何渠道开启** + 无记录。 */
export const DEFAULT_AUTO_CHECKIN: AutoCheckinDoc = {
  providers: {},
  channels: [],
  dismissedRunAt: 0,
  lastAt: 0,
}

/** 单渠道的默认配置（未在文档里出现过的渠道按它初始化）。 */
export function defaultProviderDoc(): AutoCheckinProviderDoc {
  return {
    enabled: false,
    time: DEFAULT_AUTO_CHECKIN_TIME,
    lastDate: '',
    lastResult: '',
    lastAt: 0,
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * `HH:mm` 的**唯一**校验式（24 小时制，两位小时 + 两位分钟）。
 *
 * ⚠️ 客户端、RPC 写入路径、本文件的宽松回落都必须以它为准 —— 各写一份会在
 * 将来加宽格式时静默漂移，表现为「UI 能存、调度不生效」。故**导出**，别在别处
 * 抄字面量。
 */
export const AUTO_CHECKIN_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 逐渠道条目的上限：渠道总数就 12 个，留一点余量即可（脏数据不该撑大文档）。 */
const MAX_CHANNEL_ENTRIES = 24

/** 归一化逐渠道结果（丢非法项、截断超长文本、限制条数）。 */
function sanitizeChannels(raw: unknown): Array<{ provider: string; text: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ provider: string; text: string }> = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.provider !== 'string' || record.provider.length === 0) continue
    if (typeof record.text !== 'string') continue
    out.push({ provider: record.provider, text: record.text.slice(0, 120) })
    if (out.length >= MAX_CHANNEL_ENTRIES) break
  }
  return out
}

/**
 * 归一化签到时间：非法值一律回落 {@link DEFAULT_AUTO_CHECKIN_TIME}（**不抛错**）。
 *
 * ⚠️ 刻意**不做**宽松匹配（如把 `'9:05'` 补成 `'09:05'`、把 `'10:05:00'` 截断）：
 * RPC 写入路径要求严格取值并拒绝非法输入（见 `usage.autoCheckin`），若这里又
 * 悄悄修正变体，两处判据就会不一致 —— 与 `sanitizeBadgePreference` 同口径。
 */
export function sanitizeAutoCheckinTime(raw: unknown): string {
  return typeof raw === 'string' && AUTO_CHECKIN_TIME_RE.test(raw) ? raw : DEFAULT_AUTO_CHECKIN_TIME
}

/**
 * 归一化单个渠道的配置（**不抛错**，脏数据回落默认值）。
 *
 * ⚠️ `enabled` 判据是「只有显式 `true` 才算打开」：旧写法 `!== false` 会把
 *「文档里没有该字段」与脏数据（`'false'` / `0` / `null`）统统判成**打开** ——
 * 照抄会让从没开过开关的用户被静默开启自动签到。
 */
export function sanitizeProviderDoc(raw: unknown): AutoCheckinProviderDoc {
  const base = defaultProviderDoc()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base
  const record = raw as Record<string, unknown>
  const ms = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  return {
    enabled: record.enabled === true,
    time: sanitizeAutoCheckinTime(record.time),
    lastDate: typeof record.lastDate === 'string' && DATE_RE.test(record.lastDate) ? record.lastDate : '',
    lastResult: typeof record.lastResult === 'string' ? record.lastResult.slice(0, 200) : '',
    lastAt: ms(record.lastAt),
  }
}

/**
 * 归一化文档：非法值一律回落默认值（**不抛错**）。
 *
 * ⚠️ 与 RPC 写入路径的严格校验**不冲突**：那条路径面对用户输入，要拒绝非法值；
 * 这条路径面对**磁盘上的脏数据**（手工编辑过、被旧版本写坏），回落比整机不可用
 * 更合理 —— 判据口径与 `sanitizeBadgePreference` 一致。
 *
 * ## ⚠️ 旧文档（全局模型）的迁移口径
 *
 * 2026-10-24 之前文档长这样：`{ enabled: true, time: '10:05', lastDate: ... }`
 * —— 全局开关 + 全局时间，**没有 `providers`**。迁移规则：
 *
 * - `providers` 存在 ⇒ 按新模型读，逐渠道归一化（旧字段忽略）。
 * - `providers` 缺失 ⇒ 产出**空 providers**（即全部渠道按默认关闭）。
 *   ⚠️ **不把旧 `enabled: true` 展开成「所有渠道都开」**：用户 2026-10-24
 *   明确要求「默认为 false」，而旧 `true` 表达的是「全部渠道都要签」这个
 *   已经不存在于新模型的语义。展开会让升级后的用户看到一个自己没开过的
 *   开关处于打开状态，无从判断该关哪个。
 * - 旧 `time` **不丢**：作为 `defaults.time` 传出去（由调用方作为各渠道的
 *   初始时间），这样用户原先设的 10:05 不会被打回默认值。
 */
export function sanitizeAutoCheckin(raw: unknown): AutoCheckinDoc {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_AUTO_CHECKIN, providers: {} }
  }
  const record = raw as Record<string, unknown>
  const ms = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  const providers: Record<string, AutoCheckinProviderDoc> = {}
  if (typeof record.providers === 'object' && record.providers !== null && !Array.isArray(record.providers)) {
    for (const [id, value] of Object.entries(record.providers as Record<string, unknown>)) {
      // 渠道 id 只接受非空字符串键；数量上限防脏数据把文档撑大。
      if (id.length === 0 || id.length > 64) continue
      providers[id] = sanitizeProviderDoc(value)
      if (Object.keys(providers).length >= MAX_CHANNEL_ENTRIES) break
    }
  }
  return {
    providers,
    channels: sanitizeChannels(record.channels),
    dismissedRunAt: ms(record.dismissedRunAt),
    lastAt: ms(record.lastAt),
  }
}

/**
 * 从**旧文档**里取出它记录的时间，作为各渠道的初始值。
 *
 * ⚠️ 只取 `time`，**不取 `enabled`**（理由见 {@link sanitizeAutoCheckin} 的
 * 迁移口径）。返回 `undefined` 表示旧文档没有可用时间，调用方用默认值。
 */
export function legacyAutoCheckinTime(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const value = (raw as Record<string, unknown>).time
  return typeof value === 'string' && AUTO_CHECKIN_TIME_RE.test(value) ? value : undefined
}

/**
 * 取「UTC+8 的当天日期」（`YYYY-MM-DD`）。
 *
 * ⚠️ 必须用**算术平移**而不是本机时区：日界归服务端（各渠道的每日额度按 UTC+8
 * 结算），取本机时区会在用户出差/改系统时区时得到错的「今天」—— 偏东会提前把
 * 当天记为已跑（真的漏签），偏西会一天跑两次。偏移量复用 `model-queue.ts` 的
 * `QODER_BILLING_UTC_OFFSET_MS`（同一口径，不另立常量）。
 */
export function utc8DateString(nowMs: number = Date.now()): string {
  return new Date(nowMs + QODER_BILLING_UTC_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 取「UTC+8 当天的墙上时间」（`HH:mm`），**只用于日志**。
 *
 * ⚠️ 与 {@link utc8DateString} 同一手法（算术平移 + `getUTC*`）。存在的唯一理由
 * 是让「还没到点」的日志能自证算术没错：用户看到「设定 10:05，当前 09:12」
 * 就能立刻判断是不是时区算错了。
 */
export function utc8ClockString(nowMs: number = Date.now()): string {
  const shifted = new Date(nowMs + QODER_BILLING_UTC_OFFSET_MS)
  const hours = String(shifted.getUTCHours()).padStart(2, '0')
  const minutes = String(shifted.getUTCMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * 取「UTC+8 当天的**分钟数**」（`0` = 00:00，`1439` = 23:59）。
 *
 * 把「现在几点」与「设定时间」都折成同一个整数再比大小，避免分别比时分
 * （`hour > h || (hour === h && minute >= m)` 那种写法容易把边界写错）。
 *
 * ⚠️ 与 {@link utc8DateString} 同一手法：**算术平移 + `getUTC*`**，不是
 * `getHours()`。`getHours()` 按**本机时区**取值，在非 UTC+8 的机器上会算出错的
 * 「现在几点」—— 用户把系统时区改到 UTC-5 时，10:05 的签到会变成当地 23:05 才跑。
 * 平移后 `getUTCHours()` 读到的就是 UTC+8 的墙上时间（偏移量取自
 * `model-queue.ts` 的 `QODER_BILLING_UTC_OFFSET_MS`，不另立常量）。
 *
 * @param nowMs - 当前 UTC 毫秒时间戳（注入以便单测）。
 * @returns UTC+8 当日已过的分钟数（`0`–`1439`）。
 */
export function utc8MinutesOfDay(nowMs: number = Date.now()): number {
  const shifted = new Date(nowMs + QODER_BILLING_UTC_OFFSET_MS)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}

/**
 * 把 `HH:mm` 解析成「当日分钟数」（`0`–`1439`）；非法值返回 `undefined`。
 *
 * ⚠️ 不抛错、不回落：调用方（{@link isTimeReachedToday}）需要区分「没到时间」
 * 与「时间写坏了」。前者该继续等，后者该告警 —— 合并成 `0` 会让坏配置表现成
 * 「凌晨就跑」，反而更难查。
 */
export function parseTimeOfDay(time: string): number | undefined {
  if (!AUTO_CHECKIN_TIME_RE.test(time)) return undefined
  const [hours, minutes] = time.split(':')
  return Number(hours) * 60 + Number(minutes)
}

/**
 * 「今天（UTC+8）是否已经到达设定时间」。
 *
 * ⚠️ 判据是 `>=` 而不是 `===`：周期检查每 5 分钟才醒一次，用相等判断会**必然
 * 错过**（除非设定时间恰好落在检查节拍上）。`>=` 让「到点后任何一次检查」都能
 * 触发，且配合 `lastDate !== 今天` 的守卫保证当天只跑一轮。
 *
 * ⚠️ 设定时间非法时返回 `false`（**不**当作「已到点」）：宁可当天不自动签，
 * 也不要在用户没预期的时刻打上游。脏数据已在 `sanitizeAutoCheckin` 回落过，
 * 走到这里还是非法说明是内存里被改坏的，告警由调用方打。
 *
 * ⚠️ **本函数只管「纯到点」，不含日末补偿**（见 {@link isCheckinDue}）：
 * 它的语义是「现在这个瞬间，今天的目标时刻过了吗」，是一个**无相位依赖**的
 * 纯函数。调度要的是另一个问题（「这一轮检查该不该签」），那个问题还牵涉
 * 周期检查的相位 —— 两者混在一个函数里会让纯判据也被迫认识 `tickMs`。
 *
 * @param time - `HH:mm`（UTC+8 语义）。
 * @param nowMs - 当前 UTC 毫秒时间戳（注入以便单测）。
 */
export function isTimeReachedToday(time: string, nowMs: number = Date.now()): boolean {
  const target = parseTimeOfDay(time)
  if (target === undefined) return false
  return utc8MinutesOfDay(nowMs) >= target
}

/** 一天的分钟数（`24 * 60`）。日末补偿判据用它算「离午夜还剩几分钟」。 */
const MINUTES_PER_DAY = 24 * 60

/**
 * 一次检查的结果：该不该签、以及**为什么**。
 *
 * `reason` 只用于日志与排障 —— 调度只关心 `due`。
 */
export interface CheckinDueDecision {
  /** 这一轮该不该签。 */
  due: boolean
  /**
   * 判定的依据，三种之一：
   * - `reached`：今天已过设定时刻（常规路径，绝大多数情况走这里）；
   * - `last-chance`：还没到设定时刻，但**下一次检查会跨过午夜** ⇒ 再等就永远等不到；
   * - `waiting`：还没到点，且下一次检查仍在今天之内 ⇒ 继续等。
   *
   * ⚠️ 时间非法时返回 `due: false` + `reason: 'waiting'`：调用方另有守卫专门
   * 处理非法配置（打 `warn`），这里不重复判定。
   */
  reason: 'reached' | 'last-chance' | 'waiting'
}

/**
 * 「这一轮检查该不该签」——**调度的真实判据**（含日末补偿）。
 *
 * ## ⚠️ 为什么需要它：日末盲区（真实缺陷，2026-10-23 定位）
 *
 * 只用 {@link isTimeReachedToday} 会漏签一类配置。成因是**周期检查有相位**：
 * 相位由 `start()` 那一刻决定，此后每 `tickMs` 醒一次。若设定时间落在「当天
 * 最后一个 tick 之后、午夜之前」这段窗口内，那么：
 *
 * - 最后一次 tick 在 `target` **之前** ⇒ `>=` 为 false，不签；
 * - 下一次 tick 已经跨过午夜 ⇒ 属于**新的一天**，minutes 归 0 ⇒ `0 >= 1439` 为 false。
 *
 * 于是「已过 target」这个条件**当天永远观察不到**，整天静默漏签。
 *
 * 具体例子（相位 minute ≡ 1 mod 5，即 tick 落在 00:01 / 00:06 / … / 23:56）：
 * 最后一次检查 23:56（minutes=1436），下一次 00:01（minutes=1）。设定
 * `23:57` / `23:58` / `23:59` 三者**全部漏签**。
 *
 * ## 补偿判据：`minutes + tickMinutes >= 1440`
 *
 * 语义是「**下一次检查已经不在今天了**」。一旦成立，今天的 `target` 就再也
 * 观察不到，必须在这次检查里签掉，否则整天落空。故这一轮按「最后机会」放行。
 *
 * ⚠️ 为什么是 `>=` 而不是 `>`：`tickMinutes` 是**下一次检查的最早**间隔，实际
 * 触发可能因事件循环延迟而更晚。用 `>=` 覆盖「恰好贴着午夜」那一格（如 23:55 +
 * 5 分钟 = 24:00），宁可早签一次也不漏。
 *
 * ⚠️ 代价是「**最多提前一个 tick 窗口**」（≤5 分钟）。这是刻意的权衡：晚签的
 * 后果是**整天漏领**（额度按天结算、过期不补），早签 5 分钟的后果只是「比设定
 * 时间早一点」——两者不对称，故选择早签。
 *
 * ## ⚠️ 为什么默认值 `10:05` 完全不受影响
 *
 * 补偿分支要求 `minutes >= 1440 - tickMinutes`（5 分钟周期即 `>= 1435`，23:55 之后）。
 * 而 23:55 时 `10:05` 早就 `>=` 过了，**第一分支先命中**，根本走不到补偿。
 * 故补偿只可能影响「设定时间本身就在日末 5 分钟内」的配置 —— 正是原来漏签的那批。
 *
 * ## ⚠️ 为什么不用「补偿昨天漏签」的思路
 *
 * 试过：若 `lastDate` 不是今天也不是昨天，则在新的一天补偿一轮。它**修不好**
 * 这个缺陷 —— 第 1 天凌晨补签后 `lastDate` 变成第 1 天，第 2 天凌晨时
 * `lastDate === 昨天` ⇒ 不补，而 `target` 依旧观察不到 ⇒ 第 2、3 天继续漏。
 * 实测三天只签 1 次（应为 3 次）。根因是「漏签」不是历史欠账，而是**当天这一轮
 * 从未被观察到**，必须在当天之内解决。
 *
 * @param time - `HH:mm`（UTC+8 语义）。
 * @param nowMs - 当前 UTC 毫秒时间戳（注入以便单测）。
 * @param tickMs - 周期检查的间隔（毫秒），即「下一次检查最多多久之后」。
 */
export function isCheckinDue(
  time: string,
  nowMs: number = Date.now(),
  tickMs: number = AUTO_CHECKIN_TICK_MS,
): CheckinDueDecision {
  const target = parseTimeOfDay(time)
  // 非法时间：不签，也不声称是「最后机会」（调用方另有 warn 守卫）。
  if (target === undefined) return { due: false, reason: 'waiting' }
  const minutes = utc8MinutesOfDay(nowMs)
  if (minutes >= target) return { due: true, reason: 'reached' }
  // 下一次检查的分钟数（向上取整：宁可把窗口算宽一点，也不要漏掉边界）。
  const tickMinutes = Math.max(1, Math.ceil(tickMs / 60_000))
  if (minutes + tickMinutes >= MINUTES_PER_DAY) return { due: true, reason: 'last-chance' }
  return { due: false, reason: 'waiting' }
}

/** 环境变量：启动后延迟多久再尝试自动签到（毫秒）。 */
export const DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS = 'DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS'

/** 默认延迟（毫秒）。理由见文件头「为什么延迟 30 秒」。 */
export const AUTO_CHECKIN_DELAY_MS = 30_000

/**
 * 周期检查的间隔（毫秒）：**5 分钟**。
 *
 * ## 为什么需要周期检查，而不是一个「算到明天 10:05」的长定时器
 *
 * ⚠️ 长定时器在**笔记本合盖休眠**下必然漂移：`setTimeout(24 小时)` 在合盖期间
 * 不走，唤醒后可能已经错过设定时刻，而长定时器**不会自己补** —— 于是「今天又
 * 没签」。周期检查是**幂等**的：每次醒来都重新问一遍「现在到点了吗」，最多晚
 * 一个周期，且天然处理跨天。
 *
 * ## 为什么是 5 分钟
 *
 * 三个约束相权：
 * - **精度够用**：签到是「每日一次」的业务，晚 5 分钟没有任何后果（额度按天算）；
 * - **空转成本可忽略**：一天 288 次检查，每次只是几次整数比较，**不发任何请求**；
 * - **不会把定时器排太密**：1 分钟粒度在合盖唤醒后容易连打多次，5 分钟足够稀。
 */
export const AUTO_CHECKIN_TICK_MS = 5 * 60_000

/**
 * 读延迟配置。
 *
 * ⚠️ 不能写成 `Number(env.X) || 默认值`：`0` 是**合法**值（立刻执行），
 * 而 `0` 是 falsy 会被静默换成 30 秒 —— 与本仓库 `DSH_CHANNEL_PACK_BADGE_TTL_MS`、
 * `DSH_QODER_QUEUE_TIMEOUT_MS` 记过的是同一个坑。
 */
export function autoCheckinDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS]
  if (typeof raw !== 'string' || raw.trim().length === 0) return AUTO_CHECKIN_DELAY_MS
  const parsed = Number(raw.trim())
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : AUTO_CHECKIN_DELAY_MS
}

/** 文档后端：文件（正常）或内存（定位不到 dsh home 时的显式降级）。 */
export type AutoCheckinStoreKind = 'file' | 'memory'

/** 文档读写接口（同步读、异步写，与 `BadgePreferenceStore` 同款约定）。 */
export interface AutoCheckinStore {
  readonly kind: AutoCheckinStoreKind
  /** 载入文档；不存在 / 损坏 / 字段非法时返回默认值。 */
  load(): AutoCheckinDoc
  /** 整份写入（原子写）。 */
  save(doc: AutoCheckinDoc): Promise<void>
}

class MemoryAutoCheckinStore implements AutoCheckinStore {
  readonly kind = 'memory' as const
  private doc: AutoCheckinDoc = { ...DEFAULT_AUTO_CHECKIN }

  load(): AutoCheckinDoc {
    return { ...this.doc }
  }

  async save(doc: AutoCheckinDoc): Promise<void> {
    this.doc = { ...doc }
  }
}

class FileAutoCheckinStore implements AutoCheckinStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): AutoCheckinDoc {
    try {
      if (!existsSync(this.path)) return { ...DEFAULT_AUTO_CHECKIN }
      return sanitizeAutoCheckin(JSON.parse(readFileSync(this.path, 'utf-8')) as unknown)
    } catch (error) {
      // 损坏时回落默认值而不是抛错：这是后台任务，读不到文档不该让插件起不来。
      // ⚠️ 默认值现在是「**关闭**」（见 `DEFAULT_AUTO_CHECKIN`），所以回落的后果
      // 是「不自动签到」，不是「照常签」。早先这里写的是「按默认设置（开启）」，
      // 那是默认值翻转前的旧语义 —— 留着会把排障引到反方向。
      this.logger?.warn(`[channel-pack] 读取 ${this.path} 失败，自动签到按默认设置（关闭）处理: ${String(error)}`)
      return { ...DEFAULT_AUTO_CHECKIN }
    }
  }

  async save(doc: AutoCheckinDoc): Promise<void> {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify({
      schema: SCHEMA,
      // ⚠️ `providers` 必须落盘：否则每次重启都回到「全部关闭 + 默认 10:05」，
      // 用户设的开关与时间静默丢失 —— 那是本功能最容易被当成「又坏了」的形态。
      providers: doc.providers,
      channels: doc.channels,
      lastAt: doc.lastAt,
      dismissedRunAt: doc.dismissedRunAt,
    }, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
}

/** 创建文档后端（home 与账号池 / 偏好文档用**同一个** `resolveChannelPackHome`）。 */
export function createAutoCheckinStore(ctx: Context): AutoCheckinStore {
  const home = resolveChannelPackHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[channel-pack] 无法定位 DSH home，自动签到开关仅存在于内存中')
    return new MemoryAutoCheckinStore()
  }
  return new FileAutoCheckinStore(join(home, 'channel-pack', AUTO_CHECKIN_FILE), ctx.logger)
}

/** 一轮执行的累计口径（账号级计数来自各渠道的 `summary`）。 */
interface RunTotals {
  /** 真正跑过 `claimAll` 的渠道数（不含被跳过的）。 */
  providers: number
  claimed: number
  totalCredit: number
  /**
   * ★ **按单位分组**的合计（2026-10-04）。
   *
   * ⚠️ 展示路径**必须**用它而不是 {@link totalCredit}：后者跨单位求和，
   * 会把 ZCode 的 token 与其余渠道的积分加成一个数（真实缺陷，见
   * `RpcCreditsClaimSummary.totalByUnit`）。
   */
  totalByUnit: Record<'token' | 'credit', number>
  alreadyClaimed: number
  inactive: number
  failed: number
  /**
   * 其中**能证明「今天这一轮已被处理」**的账号数（来自 `summary.coversToday`）。
   *
   * ⚠️ 这是 {@link shouldMarkToday} **唯一**该看的口径 —— 不能用
   * `claimed + alreadyClaimed`：那两项里混着「刷新前那一轮」的痕迹
   * （Qoder 活动 10:00 UTC+8 才刷新），拿它们记账会让当天新额度整天漏领。
   * 字段语义见 `src/credits.ts` 的 `ClaimOutcomeCommon.coversToday`。
   */
  coversToday: number
  /** 渠道级：不支持签到（`claimAll` 未发上游请求就返回的那些）。 */
  skipped: number
  /** 渠道级：其它错误（凭据、网络……）。 */
  errors: number
}

function emptyTotals(): RunTotals {
  return { providers: 0, claimed: 0, totalCredit: 0, totalByUnit: { token: 0, credit: 0 }, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0, skipped: 0, errors: 0 }
}

/**
 * 「不支持每日签到」的判据：`credits.claimAll` 对 cline / raccoon / workbuddy
 * 返回的**显式**错误文案（这三条分支都不发上游请求）。
 *
 * ⚠️ 兜底认 `unsupported provider`：那是 `productById` 找不到产品时的文案，
 * 语义同样是「这个渠道没有可用的签到实现」，计成失败只会制造假警报。
 * ⚠️ 判据必须**窄**：只匹配这两个短语，不要泛化成「含 unsupported」之类，
 * 免得把真正的参数错误也吞掉。
 */
export function isUnsupportedCheckin(message: string): boolean {
  return message.includes('不支持每日签到') || message.includes('unsupported provider')
}

/**
 * ⚠️ **自动签到不适合**的渠道：领取过程需要**用户在场 / 外部程序**。
 *
 * ## 为什么不靠「错误文案」判（真实缺陷，2026-10-02 审查 PR !33 定位）
 *
 * 本文件原先的规则是「判据交给 `credits.claimAll` 自己：不支持的渠道会
 * **不发上游请求**就返回错误」。那对 cline / raccoon / workbuddy 成立 ——
 * 它们的守卫在 `claimAll` 里，返回前一个请求都没发。
 *
 * 但**漏了一类**：zcode **有**签到，只是每次领取都要现场产一个阿里云
 * captcha param（`channel-pack-rpc.ts` 的 zcode 分支无条件调 `zcode.mintCaptcha`）。
 * web 版下它会**拉起 headful Chromium**（约 200–400MB），而阿里云按**设备**
 * 限流「同设备每小时 150 次」。默认开启的自动签到等于：用户什么都没点，
 * 开 DSH 就起一棵浏览器进程树、白耗设备级配额；一旦这轮失败又不写 `lastDate`
 * ⇒ **每次启动都重来**，一天开十次就是十轮 captcha。
 *
 * ## 判据与维护口径
 *
 * - 这张表是**第二份名单**，但它记的不是「谁有签到接口」（那仍由
 *   `claimAll` 的守卫 + 客户端能力表负责），而是「谁有签到**代价**」——
 *   后者无处可查，只能显式登记。**新增带 captcha / 外部浏览器的 provider 时，
 *   必须同时登记到这里**（`tests/unit/auto-checkin.spec.ts` 有反向守护用例：
 *   一旦 zcode 的 claim 分支又开始调 `mintCaptcha`，而本表没登记，用例会红）。
 * - 用户仍可在面板里**手动**点 zcode 的「一键领取积分」—— 那是有意行为，
 *   浏览器弹出来是用户自己能理解的交互。
 */
export function isAutoCheckinExcluded(provider: string): boolean {
  return provider === ZCODE.id
}

/**
 * **没有**每日签到接口的渠道（显式登记，服务端唯一权威）。
 *
 * ## ⚠️ 为什么需要这张表（2026-10-24 逐渠道改造引入）
 *
 * 改造前，本模块靠「调 `claimAll`、按返回的错误文案判跳过」来识别不支持的渠道
 *（{@link isUnsupportedCheckin}）—— 那在「一次跑全部渠道」的模型下够用，因为
 * 多打一次空请求的代价只是慢一点。
 *
 * 逐渠道之后不够了：UI 要在**用户点开某个渠道时**就告诉他「这个渠道不支持
 * 每日签到」，不可能为了渲染一个置灰状态去打一次上游。故必须有一份**可离线
 * 查询**的名单。
 *
 * ## ⚠️ 这是第二份名单，维护口径如下
 *
 * - 与 `channel-pack-rpc.ts` 里 `credits.claimAll` 的三条显式守卫
 *  （cline / workbuddy / raccoon）**必须同步**：那三条是「不发请求就返回」的
 *   实现事实，这里是它的声明式镜像。新增一条守卫时这里要一起加，否则 UI 会
 *   把一个不支持的渠道显示成可开启，用户打开后永远签不到东西（静默失效）。
 * - zcode **不在**这张表里：它有签到接口，只是代价高（captcha + 拉浏览器），
 *   由 {@link isAutoCheckinExcluded} 单独排除。两者语义不同，别混：
 *   这里答「有没有」，那里答「值不值得自动跑」。
 * - 表外的渠道**默认视为支持**：宁可让用户看到一个可以打开、但跑起来会被
 *   `isUnsupportedCheckin` 判跳过的开关，也不要因为漏登记而把一个真支持的
 *   渠道置灰 —— 后者用户无法自行绕过。
 */
export const AUTO_CHECKIN_UNSUPPORTED = new Set<string>(['cline', 'workbuddy', 'raccoon'])

/**
 * 某渠道能否被自动签到。
 *
 * 判据 = 「有签到接口」**且**「不值得自动跑」不成立。两者缺一不可：
 * - 只有前者 ⇒ zcode 会被自动跑，拉起浏览器产 captcha（见
 *   {@link isAutoCheckinExcluded} 的代价说明）。
 * - 只有后者 ⇒ cline / raccoon 会被跑，白打一轮必然失败的请求。
 */
export function supportsAutoCheckin(provider: string): boolean {
  return !AUTO_CHECKIN_UNSUPPORTED.has(provider) && !isAutoCheckinExcluded(provider)
}

/** 把一轮结果拼成一句中文摘要（给状态灯提示与日志用）。 */
export function describeRun(totals: RunTotals): string {
  const parts: string[] = []
  if (totals.claimed > 0) {
    // ★ 按单位分别报（2026-10-04，真实缺陷）：原先写 `+${totals.totalCredit} 积分`，
    //   而 `totalCredit` 是**跨单位求和** —— ZCode 的 1 亿 token 与 100 积分会被
    //   加成 `100000100` 并标成「积分」。用户报障原文给的期望形态就是
    //   `+100Mtoken, +100积分`（见 `credits.ts` 的 `formatClaimGains`）。
    const amounts = formatClaimGains(totals.totalByUnit ?? { credit: totals.totalCredit })
    parts.push(`${totals.claimed} 个账号领取成功${amounts === null ? '' : `（${amounts}）`}`)
  }
  if (totals.alreadyClaimed > 0) parts.push(`${totals.alreadyClaimed} 个今天已领`)
  if (totals.failed > 0) parts.push(`${totals.failed} 个失败`)
  if (totals.errors > 0) parts.push(`${totals.errors} 个渠道出错`)
  if (totals.skipped > 0) parts.push(`${totals.skipped} 个渠道不支持签到`)
  if (parts.length === 0) return `${totals.providers} 个渠道：没有需要领取的账号`
  return `${totals.providers} 个渠道：${parts.join('，')}`
}

/**
 * 这一轮该不该把「今天」记为已跑。
 *
 * 判据：**至少有一个账号能证明「今天这一轮已被处理」**（`coversToday > 0`）才记。
 *
 * ⚠️⚠️ **为什么不能看 `claimed + alreadyClaimed`**（真实缺陷，2026-10-02 审查
 * PR !33 定位）：那两项里混着「**刷新前那一轮**」的痕迹。Qoder 的活动每日
 * 10:00（UTC+8）才刷新，于是上午 9 点跑的那一轮看到的是**昨天**那条 `CLAIMED`
 * —— 记成「今天已跑」之后，当天 10 点刷新出来的新额度**整天不会再被领**，
 * 而且界面还显示「1 个今天已领」，用户毫无提示。渠道自己用
 * `ClaimOutcome.coversToday` 标出「这条不算今天」，本函数只负责数。
 *
 * 反例（不记、下次启动重试）：
 * - 整轮零成功零已领（凭据全过期 / 网络不通 / 启动太早抢在续期之前）——
 *   若记了，用户当天就再也不会自动签到，且界面只说「上次：N 个失败」；
 * - 跑完但**没有一条能证明今天**（例如只有 Qoder 且赶在 10:00 之前）——
 *   同理不记，当天稍后还有机会；
 * - 一个渠道都没跑（全被跳过）：没有意义，不记。
 * 反之「有成功也有失败」要记：否则一个坏账号会让插件每次启动都把好账号再领一遍
 * （虽然幂等，但白白多发请求）。
 */
export function shouldMarkToday(totals: RunTotals): boolean {
  return totals.coversToday > 0
}

/**
 * 单个渠道的短状态（面板上那行常驻文字用它逐渠道列出，用户要求「这样才能够知道
 * **各个渠道**的签到状态」）。
 *
 * ⚠️ 必须**短**：9 个渠道要挤在 280px 的面板里一行一个片段，长文案会撑成好几屏。
 * 故只给「几个账号 + 什么结果」，不带渠道名（渠道名由展示层补）。
 */
export function describeChannel(summary: {
  claimed: number
  totalCredit: number
  alreadyClaimed: number
  inactive: number
  failed: number
  /** 见 `RpcCreditsClaimSummary.coversToday`；缺省按 `claimed+alreadyClaimed` 兜底。 */
  coversToday?: number
  /**
   * ★ 按单位分组的合计（2026-10-04）。**缺省回落到「全部按积分」**，
   * 以兼容尚未上报该字段的旧响应（与 `coversToday` 的兜底同思路）。
   */
  totalByUnit?: Partial<Record<'token' | 'credit', number>>
}): string {
  const parts: string[] = []
  if (summary.claimed > 0) {
    // ⚠️ 「领到了但 +0 分」与「今天已领」必须能分辨：前者写成「已领」会和
    // alreadyClaimed 撞词，用户无法判断这次到底有没有动作。
    //
    // ★ 单位感知（2026-10-04）：原先写裸数字 `+${summary.totalCredit}`，
    //   于是 ZCode 那行显示 `1 个 +100000000` —— 既看不出单位，量级也读不出来。
    //   用户给的期望形态是 `+100Mtoken`（见 `credits.ts` 的 `formatClaimGains`）。
    const amounts = formatClaimGains(summary.totalByUnit ?? { credit: summary.totalCredit })
    parts.push(amounts === null ? `${summary.claimed} 个领取成功` : `${summary.claimed} 个 ${amounts}`)
  }
  if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今天已领`)
  if (summary.failed > 0) parts.push(`${summary.failed} 个失败`)
  if (summary.inactive > 0) parts.push(`${summary.inactive} 个未开启`)
  if (parts.length === 0) return '无可领'
  // ⚠️ 声称「今天已领」之前先自问一句：这些痕迹是不是**今天这一轮**的？
  // Qoder 在 10:00（UTC+8）刷新前看到的 `CLAIMED` 属于昨天 —— 此时那句
  // 「今天已领」既不准确，又会让用户以为今天不必再领。
  const coversToday = summary.coversToday ?? (summary.claimed + summary.alreadyClaimed)
  if (coversToday === 0 && (summary.claimed + summary.alreadyClaimed) > 0) {
    parts.push('非今日轮次')
  }
  return parts.join('，')
}

/** 装配层注入的依赖（全部可替换 ⇒ 单测零网络、零文件系统、零等待）。 */
export interface AutoCheckinDeps {
  store: AutoCheckinStore
  /**
   * 列出**账号池里有账号**的渠道 id。
   * 只遍历有账号的渠道：没有账号的渠道调 `claimAll` 只会拿到空结果，白白走一遍
   * 12 条分支。
   */
  listProviderIds(): Promise<string[]>
  /**
   * 调某个渠道的签到 —— **必须复用 `credits.claimAll` 的实现**（装配层直接调内部
   * `handleMethod`）。本模块不认任何具体渠道，只按返回的信封判「跳过 / 失败」。
   */
  claim(provider: string): Promise<BadgeRpcResult<RpcCreditsClaimAllResponse>>
  now?(): number
  /** 延迟毫秒数；默认读环境变量。 */
  delayMs?: number
  /**
   * 周期检查的间隔毫秒数；默认 {@link AUTO_CHECKIN_TICK_MS}。
   *
   * ⚠️ 单测用它把间隔压到 0/1ms 驱动跨天场景，**不要**在生产里调小 ——
   * 5 分钟的意义见文件头「为什么是每 5 分钟检查一次」。
   */
  tickMs?: number
  /** 排定延迟执行（注入以便单测零等待）。返回值交给 `stop()` 取消。 */
  schedule?(fn: () => void, ms: number): { cancel(): void }
  /** 排定**周期**执行（注入以便单测驱动）。返回值交给 `stop()` 取消。 */
  scheduleInterval?(fn: () => void, ms: number): { cancel(): void }
  /**
   * 打一条 `warn` 级日志。
   *
   * ⚠️ 保留原名（不改成 `error` / `log`）：装配层与单测都按这个名字注入。
   */
  warn?(message: string): void
  /**
   * 打一条 `debug` 级日志（守卫拦截、周期心跳这类**预期**的静默）。
   *
   * ⚠️ 与 `warn` 分开的理由：周期检查每 5 分钟一次，守卫拦截是常态，
   * 全用 `warn` 会把日志刷成噪声，用户反而看不到真正的失败。缺省时不打 ——
   * 单测不必为它准备桩。
   */
  debug?(message: string): void
}

/** 自动签到执行体（**逐渠道**）。 */
export interface AutoCheckin {
  /** 实时状态（逐渠道 + 兼容视图）。 */
  state(): RpcUsageAutoCheckinState
  /**
   * 写**某个渠道**的开关；**打开时若该渠道今天还没跑过，立刻跑一轮**
   *（否则用户会以为开关没生效）。
   *
   * ⚠️ `provider` 必须支持签到（{@link supportsAutoCheckin}）；对不支持的渠道
   * 写 `enabled: true` 返回 `false` 表示被拒 —— 静默接受等于允许用户开启一个
   * 永远不会生效的开关。写 `false` 对任何渠道都允许。
   *
   * @returns 写入后的状态；被拒时返回 `null`。
   */
  setProviderEnabled(provider: string, enabled: boolean): Promise<RpcUsageAutoCheckinState | null>
  /**
   * 写**某个渠道**的签到时间（`HH:mm`，UTC+8 语义）。
   *
   * ⚠️ **本方法不做格式校验**（类型签名已保证是 `string`，但 `'abc'` 也过得了
   * 编译）：校验在 RPC 层与 `sanitizeAutoCheckinTime`。这里若再回落一次，非法
   * 输入会被静默改成 `10:05` 并「保存成功」——正是本仓库 `usage.badgePreference`
   * 记过的那类假成功。
   *
   * 写入后**立刻按新时间重判一次**（不 await）：用户把时间改到「现在就过点了」
   * 时应当马上补签，而不是等到下一个周期。今天已跑过则由 `runIfDue` 拦住。
   */
  setProviderTime(provider: string, time: string): Promise<RpcUsageAutoCheckinState>
  /**
   * ⚠️ **兼容旧 UI 的全局 fan-out**（`client.js` 那版全局开关还在用）。
   *
   * 把所有**支持签到**的渠道一次性设成 `enabled`。这是过渡期路径：它把「用户
   * 想改哪个渠道」这个信息丢掉后再猜一遍，正是逐渠道改造要消灭的语义。
   * 等 `client.js` 也改成逐渠道后应删掉这两个方法（届时 RPC 层 `provider` 必填）。
   *
   * ⚠️ 只影响**已存在**的渠道条目 + 支持签到的渠道：不会凭空给不支持的渠道
   * 建一条 `enabled: true` 的记录（那会让界面显示一个永远不生效的开关）。
   */
  setAllEnabled(enabled: boolean): Promise<RpcUsageAutoCheckinState>
  /** 兼容旧 UI：把所有渠道的时间都设成 `time`。理由同 {@link setAllEnabled}。 */
  setAllTimes(time: string): Promise<RpcUsageAutoCheckinState>
  /**
   * 关闭面板上那行**常驻的**自动签到状态文字（用户点它上方的小按钮时调用）。
   *
   * ⚠️ 与手动签到的结果提示不同：那条是**按时自动消失**；这一条是用户要求
   * 「不要自动取消、给我开放手动关闭」。关闭记的是**这一轮**（当前的 `lastAt`），
   * 故下一轮跑出新结果时它会重新出现。
   */
  dismiss(): Promise<RpcUsageAutoCheckinState>
  /**
   * 启动时调用一次：延迟后开始**周期检查**（内部自己判各渠道的开关、时间与
   * 当天是否已跑）。
   *
   * ⚠️ 与旧实现的差别：旧版排的是一次性 `setTimeout`，跑完就再也不醒 ——
   * 进程常驻时「第二天不签」的根因。现在延迟首次检查之后转为周期检查
   * （见 {@link AUTO_CHECKIN_TICK_MS} 与文件头那一节）。
   */
  start(): void
  /** 立刻按判据跑一轮（供「刚打开开关 / 刚改时间」与单测用）。 */
  runIfDue(): Promise<void>
  /** 取消尚未执行的定时器（不打断已开始的一轮）。 */
  stop(): void
}

/** 创建自动签到执行体。 */
export function createAutoCheckin(deps: AutoCheckinDeps): AutoCheckin {
  const now = deps.now ?? (() => Date.now())
  let doc = deps.store.load()
  /** 周期检查的间隔（毫秒）。单测可注入 `tickMs` 把它压到极小。 */
  const tickMs = deps.tickMs ?? AUTO_CHECKIN_TICK_MS
  /** 在飞去重：`setProviderEnabled(true)` 与启动排定可能同时想跑。 */
  let inflight: Promise<void> | null = null
  /** 尚未触发的**首次**延迟检查（延迟 30 秒那条）。 */
  let pending: { cancel(): void } | null = null
  /** 已开始的**周期**检查（每 5 分钟一条）。 */
  let ticker: { cancel(): void } | null = null
  /**
   * 正在跑的渠道（按渠道去重，而不是全局一把锁）。
   *
   * ⚠️ 必须按渠道记：用户可以在渠道 A 跑着的时候打开渠道 B 的开关，那次
   * `runIfDue` 应当只跑 B，不该因为 A 在跑就把整轮挡掉。
   */
  const runningProviders = new Set<string>()
  /**
   * 上一次「因何跳过」的原因（用于守卫日志去重，见 `runIfDue`）。
   *
   * `null` = 上次没有被拦截（或刚真的跑过一轮）。只在原因**变化**时打日志，
   * 否则「还没到点」会在等待期间刷 288 行/天。
   */
  let lastSkipReason: string | null = null
  /**
   * 上一次「因时间配置非法而跳过」的渠道 + 那个非法值（用于告警去重）。
   *
   * 形如 `qodercn:99:99`。只在**渠道或非法值变化**时重新告警：周期检查每 5 分钟
   * 一次，不去重会把日志刷满 288 行/天；而值变了说明用户改了还是坏，要再提醒。
   */
  let invalidTimeWarned: string | null = null

  const today = (): string => utc8DateString(now())

  /** 取某渠道的配置（不存在则按默认值，**不写回** —— 读路径不该改盘）。 */
  function providerDoc(provider: string): AutoCheckinProviderDoc {
    return doc.providers[provider] ?? defaultProviderDoc()
  }

  function state(): RpcUsageAutoCheckinState {
    const ids = Object.keys(doc.providers).sort()
    const providers: RpcUsageAutoCheckinProviderState[] = ids.map((provider) => {
      const entry = doc.providers[provider]
      return {
        provider,
        enabled: entry.enabled,
        time: entry.time,
        lastDate: entry.lastDate,
        ranToday: entry.lastDate !== '' && entry.lastDate === today(),
        lastResult: entry.lastResult,
        lastAt: entry.lastAt,
        supported: supportsAutoCheckin(provider),
        running: runningProviders.has(provider),
      }
    })
    // 兼容视图：给宿主插件那版旧 UI（client.js）读。新代码只读 providers。
    const enabledEntries = providers.filter((entry) => entry.enabled)
    const latest = providers.reduce<RpcUsageAutoCheckinProviderState | undefined>(
      (best, entry) => (entry.lastAt > (best?.lastAt ?? 0) ? entry : best),
      undefined,
    )
    return {
      providers,
      enabled: enabledEntries.length > 0,
      time: enabledEntries[0]?.time ?? DEFAULT_AUTO_CHECKIN_TIME,
      lastDate: latest?.lastDate ?? '',
      ranToday: providers.some((entry) => entry.ranToday),
      running: runningProviders.size > 0,
      lastResult: latest?.lastResult ?? '',
      lastAt: doc.lastAt,
      channels: doc.channels.map((entry) => ({ ...entry })),
      dismissed: doc.lastAt > 0 && doc.dismissedRunAt === doc.lastAt,
    }
  }

  /**
   * 跑**一个**渠道。
   *
   * @returns 该渠道的结果文本；`null` 表示这次不该记 `lastDate`（下次重试）。
   */
  async function performProviderRun(provider: string): Promise<{ text: string; markToday: boolean }> {
    const totals = emptyTotals()
    // ⚠️ 排除表先于**任何**上游请求生效（见 isAutoCheckinExcluded 的说明）：
    // zcode 的代价发生在**调用期间**（拉起浏览器产 captcha），事后再判断已经
    // 太晚 —— 必须在调 `claim` 之前就把它摘掉。
    if (isAutoCheckinExcluded(provider)) {
      return { text: '需手动签到', markToday: false }
    }
    let result: BadgeRpcResult<RpcCreditsClaimAllResponse>
    try {
      result = await deps.claim(provider)
    } catch (error) {
      deps.warn?.(`[channel-pack] 自动签到：${provider} 调用异常: ${String(error)}`)
      return { text: '出错', markToday: false }
    }
    if (!result.ok) {
      const message = typeof result.error?.message === 'string' ? result.error.message : ''
      if (isUnsupportedCheckin(message)) return { text: '无签到接口', markToday: false }
      deps.warn?.(`[channel-pack] 自动签到：${provider} 失败: ${message || '未知错误'}`)
      return { text: '出错', markToday: false }
    }
    totals.providers += 1
    const summary = result.value?.summary
    if (summary === undefined) return { text: '无可领', markToday: false }
    totals.claimed += summary.claimed
    totals.totalCredit += summary.totalCredit
    // ★ 按单位累加（2026-10-04）：`totalByUnit` 缺省时回落到「全部按积分」，
    //   兼容尚未上报该字段的旧宿主响应 —— 与 `coversToday` 的兜底同思路。
    const byUnit = summary.totalByUnit ?? { credit: summary.totalCredit, token: 0 }
    totals.totalByUnit.credit += Number(byUnit.credit) || 0
    totals.totalByUnit.token += Number(byUnit.token) || 0
    totals.alreadyClaimed += summary.alreadyClaimed
    totals.inactive += summary.inactive
    totals.failed += summary.failed
    // ⚠️ 记账口径**只认**这一项：渠道用 `coversToday` 自己声明「这条痕迹是不是
    // 今天这一轮的」。缺省回落到 `claimed + alreadyClaimed`，是为了兼容尚未
    // 上报该字段的旧响应（缺字段 ≠ 0，否则整轮会被判成「什么都没证明」）。
    totals.coversToday += summary.coversToday ?? (summary.claimed + summary.alreadyClaimed)
    return { text: describeChannel(summary), markToday: shouldMarkToday(totals) }
  }

  /**
   * 跑指定的渠道集合（默认 = 当前该跑的）。
   *
   * ## 与旧实现的差别
   *
   * 旧版是「一次跑全部渠道，整轮共用一个 `lastDate`」—— 一个渠道失败就会让
   * 整轮都不记账（`shouldMarkToday` 看的是汇总）。逐渠道之后每个渠道**自己**
   * 记账：A 成功就记 A，B 失败下次单独重试，互不牵连。
   *
   * @param only - 只跑这些渠道（供「刚打开某个渠道的开关」用）。
   */
  async function performRun(only?: string[]): Promise<void> {
    const targets = only ?? (await resolveDueProviders())
    if (targets.length === 0) return
    const channels: Array<{ provider: string; text: string }> = []
    let changed = false
    for (const provider of targets) {
      runningProviders.add(provider)
      try {
        const { text, markToday } = await performProviderRun(provider)
        channels.push({ provider, text })
        const entry = doc.providers[provider] ?? defaultProviderDoc()
        if (markToday) {
          doc.providers[provider] = { ...entry, lastDate: today(), lastResult: text, lastAt: now() }
          changed = true
        } else if (text !== entry.lastResult) {
          // 没记日期的也要留下结果文本，否则界面上什么都看不到（用户会以为没跑）。
          doc.providers[provider] = { ...entry, lastResult: text, lastAt: now() }
          changed = true
        }
        if (markToday) {
          deps.warn?.(`[channel-pack] 自动签到完成（${today()}）：${provider} ${text}`)
        } else {
          deps.warn?.(`[channel-pack] 自动签到未记入今日（下个周期会重试）：${provider} ${text}`)
        }
      } finally {
        runningProviders.delete(provider)
      }
    }
    if (!changed) return
    doc = {
      ...doc,
      lastAt: now(),
      // 汇总用的 channels 只保留这一轮跑过的（旧 UI 的常驻状态文字读它）。
      channels,
      // ⚠️ 新一轮跑完要**清掉上一次的「已关闭」标记**：否则用户关过一次后，
      // 明天的新结果会被旧标记静默藏住（`dismissed` 的判据是 lastAt 相等）。
      dismissedRunAt: 0,
    }
    try {
      await deps.store.save(doc)
    } catch (error) {
      // 写盘失败 ⇒ 今天可能再跑一次（幂等，代价是多发一轮请求），如实告警。
      deps.warn?.(`[channel-pack] 自动签到结果写入失败（今天可能重复触发一次）: ${String(error)}`)
    }
  }

  /**
   * 算出**此刻该跑**的渠道：开着 + 支持签到 + 今天没跑过 + 已到点。
   *
   * ⚠️ 逐渠道判 due（每个渠道有自己的 `time`），不是全局一个判据 —— 这正是
   * 本次改造的核心。日末盲区补偿（`isCheckinDue` 的 `last-chance`）逐渠道生效。
   *
   * @param only - 只在这些渠道里筛（供「刚打开某个渠道的开关」精确触发）。
   *   ⚠️ 这是**范围**限定，不是**判据**豁免：给出的渠道仍要过全部 due 判定。
   */
  async function resolveDueProviders(only?: string[]): Promise<string[]> {
    let inPool: string[] = []
    try {
      inPool = [...new Set(await deps.listProviderIds())].sort()
    } catch (error) {
      // 账号池读不出来：不记日期，下个周期重试。
      deps.warn?.(`[channel-pack] 自动签到：读取账号池失败，本次跳过: ${String(error)}`)
      return []
    }
    // 给了范围就只在这些渠道里筛（顺序仍按账号池的稳定顺序）。
    const scope = only === undefined ? inPool : inPool.filter((provider) => only.includes(provider))
    const due: string[] = []
    for (const provider of scope) {
      const entry = doc.providers[provider]
      // 没配置过 = 默认关闭，直接跳过（不给它建记录，避免文档被空条目撑大）。
      if (entry === undefined || entry.enabled !== true) continue
      if (!supportsAutoCheckin(provider)) continue
      if (entry.lastDate !== '' && entry.lastDate === today()) continue
      if (runningProviders.has(provider)) continue
      /**
       * ⚠️ 非法时间必须**告警**，不能静默（真实缺口，2026-10-24 自查发现）。
       *
       * `isCheckinDue` 对非法值返回 `due: false`，于是这个渠道**当天永远不会
       * 签**，而且一句话都没有 —— 正是本文件反复记过的那类「静默失效」。
       *
       * 正常路径走不到：RPC 层严格校验 + `sanitizeProviderDoc` 宽松回落。
       * 但 `setProviderTime` 是**内存写入路径且不做校验**（那是刻意的，见它的
       * 注释），绕过 RPC 的调用方能把 `'99:99'` 写进文档，重启后才被回落。
       * 这条 warn 就是那个窗口期的唯一线索。
       *
       * ⚠️ 按「渠道 + 非法值」去重：周期检查每 5 分钟一次，不去重会刷 288 行/天
       *（与守卫日志同理）。值一变就重新告警 —— 用户改了还是坏，要再提醒一次。
       */
      if (parseTimeOfDay(entry.time) === undefined) {
        const key = `${provider}:${entry.time}`
        if (invalidTimeWarned !== key) {
          invalidTimeWarned = key
          deps.warn?.(
            `[channel-pack] 自动签到跳过（${provider}）：签到时间配置非法`
            + `（${JSON.stringify(entry.time)}），该渠道不会自动签到，请重新设置`,
          )
        }
        continue
      }
      const decision = isCheckinDue(entry.time, now(), tickMs)
      if (!decision.due) continue
      if (decision.reason === 'last-chance') {
        // ⚠️ 这条必须打出来：此时**还没到**用户设定的时刻，却要提前签。用户看到
        // 「23:56 签了、但我设的是 23:59」时，日志是唯一能解释原因的地方。
        deps.warn?.(
          `[channel-pack] 自动签到提前触发（${provider}）：设定 ${entry.time}（UTC+8），`
          + `当前 UTC+8 ${utc8ClockString(now())}`
          + `——下一次检查会跨过午夜，再等今天就永远等不到（日末盲区补偿）`,
        )
      }
      due.push(provider)
    }
    return due
  }

  /**
   * 按判据跑一轮（**逐渠道**判 due）。
   *
   * ## ⚠️ 为什么每条守卫都要打日志
   *
   * 改造前的守卫是**完全静默**的：用户看到「今天没自动签到」时，日志里一个字
   * 都没有，无法区分「开关没开」「今天已经跑过」「还没到时间」——这正是用户
   * 报障时「感觉是手动才领到的，但也查不到为什么」的直接原因。现在每条拦截都
   * 留一行说明原因。
   *
   * ## ⚠️ 为什么守卫日志要**去重**（只在原因变化时打一次）
   *
   * 周期检查每 5 分钟醒一次，一天 288 次。若每次都打，「还没到点」这条会把日志
   * 刷满 288 行，真正的失败反而被淹掉。故用 {@link lastSkipReason} 记住上次的
   * 拦截原因，**只在原因变化时**打一行 —— 排障要的是「什么时候因为什么没跑」，
   * 不是「每 5 分钟还在等」。
   *
   * 级别选择：`debug`（预期内的静默）而非 `warn`。例外是「时间配置非法」——
   * 那条说明配置坏了、当天**不会**自动签到，属于用户需要知道的事实，用 `warn`
   * 且**不去重**（坏配置不该被静默）。
   *
   * @param only - 只跑这些渠道（供「刚打开某个渠道的开关」精确触发，不去碰别的）。
   */
  function runIfDue(only?: string[]): Promise<void> {
    /** 打一条「因 X 跳过」的日志，同一原因连续出现时只打一次。 */
    const skip = (reason: string): Promise<void> => {
      if (lastSkipReason !== reason) {
        lastSkipReason = reason
        deps.debug?.(`[channel-pack] 自动签到跳过：${reason}`)
      }
      return Promise.resolve()
    }
    // ⚠️ 去重按**渠道**：只有「这批目标渠道全都还在跑」才算 inflight 冲突。
    if (only !== undefined && only.every((provider) => runningProviders.has(provider))) {
      deps.debug?.(`[channel-pack] 自动签到跳过：目标渠道仍在进行中（inflight）`)
      return inflight ?? Promise.resolve()
    }
    if (only === undefined) {
      // 整轮检查：没有**任何**渠道开着就直接跳过，不读账号池。
      if (!Object.values(doc.providers).some((entry) => entry.enabled === true)) {
        return skip('没有任何渠道开启自动签到')
      }
      if (inflight !== null) {
        // 不走去重：这条与「等待中」是不同性质的事件，且本身就稀少。
        deps.debug?.(`[channel-pack] 自动签到跳过：上一轮仍在进行中（inflight）`)
        return inflight
      }
    }
    const targets = only ?? null
    lastSkipReason = null
    const task = (async () => {
      let list: string[]
      if (targets === null) {
        list = await resolveDueProviders()
        if (list.length === 0) {
          // 逐渠道都判过了，这里给一句汇总原因（具体哪个渠道为什么没跑，
          // 由 resolveDueProviders 里的逐渠道日志回答）。
          skip(`今天没有到点的渠道（当前 UTC+8 ${utc8ClockString(now())}）`)
          return
        }
      } else {
        /**
         * ⚠️ **`only` 路径同样要过 due 判定**（真实缺陷，2026-10-24 自查发现）。
         *
         * 最初这里直接 `performRun(targets)`，理由是「用户刚打开开关，应当立刻
         * 尝试一轮」。但那把「立刻尝试」错解成了「立刻签」—— 后果是：用户上午
         * 8 点打开某渠道的开关，本该等到 10:05 才签，结果**当场签了一次**，
         * 于是 10:05 因为 `lastDate` 已记而不再签。签到时间形同虚设。
         *
         * 正确语义：`only` 只是「**范围**限定为这几个渠道」，判据（开关/已签/
         * 到点）一条都不能少 —— 否则「改了时间立刻重判」也就成了「改了时间立刻
         * 无视时间就签」。`resolveDueProviders` 本来就接受范围，直接复用它。
         */
        list = await resolveDueProviders(targets)
        if (list.length === 0) return
      }
      await performRun(list)
    })().catch((error: unknown) => {
      deps.warn?.(`[channel-pack] 自动签到异常: ${String(error)}`)
    }).finally(() => {
      inflight = null
    })
    inflight = task
    return task
  }

  return {
    state,
    async setProviderEnabled(provider, enabled) {
      // ⚠️ 对不支持签到的渠道写 `true` 要**拒绝**（返回 null），不能静默接受：
      // 那会让用户开一个永远不会生效的开关，而界面上它看起来是开着的。
      // 写 `false` 一律允许（关掉一个本来就不支持的渠道无害）。
      if (enabled && !supportsAutoCheckin(provider)) return null
      const entry = doc.providers[provider] ?? defaultProviderDoc()
      doc = { ...doc, providers: { ...doc.providers, [provider]: { ...entry, enabled } } }
      await deps.store.save(doc)
      // 打开开关时立刻尝试这一轮（今天已跑过则由 runIfDue 内部拦住）。
      // ⚠️ 不 await：一轮要串行打多个上游，让按钮等它会让界面像卡死；
      // `state()` 里的 `running` 会立刻变成 true，界面据此显示「进行中」。
      // ⚠️ 只跑这一个渠道（`[provider]`）：用户开 A 的开关不该顺带把 B 也签了。
      if (enabled) void runIfDue([provider])
      return state()
    },
    async setProviderTime(provider, time) {
      const entry = doc.providers[provider] ?? defaultProviderDoc()
      doc = { ...doc, providers: { ...doc.providers, [provider]: { ...entry, time } } }
      await deps.store.save(doc)
      // ⚠️ 改时间后**立刻重判**（不 await，理由同 setProviderEnabled）：用户把时间
      // 改到「已经过点」时应当马上补签，否则要等到下一个周期（最多 5 分钟）才动，
      // 界面看起来像「改了没生效」。今天已跑过 / 开关关着则由 runIfDue 拦住。
      if (entry.enabled) void runIfDue([provider])
      return state()
    },
    /**
     * ⚠️ 兼容旧 UI 的全局 fan-out，见接口注释。**新代码不要调用**。
     *
     * ## ⚠️ 为什么必须读账号池，而不是只遍历已有条目（真实缺陷，2026-10-24 自查）
     *
     * 最初这里只遍历 `doc.providers` 的现有键。但**全新安装**时那个对象是空的
     *（默认全部关闭 ⇒ 没有任何条目），于是「打开全局开关」什么都不会发生 ——
     * 旧 UI 上表现为「点了开关，状态没变，也永远不签到」。
     *
     * 正确做法：以**账号池**为范围（那才是「哪些渠道存在」的权威），逐个建条目。
     * 只跳过不支持签到的渠道（不凭空给它们建 `enabled: true`，否则界面会显示
     * 一个永远不生效的开关）。
     */
    async setAllEnabled(enabled) {
      let inPool: string[] = []
      try {
        inPool = [...new Set(await deps.listProviderIds())].sort()
      } catch (error) {
        deps.warn?.(`[channel-pack] 自动签到：读取账号池失败，无法批量改开关: ${String(error)}`)
        return state()
      }
      const providers = { ...doc.providers }
      const touched: string[] = []
      for (const id of inPool) {
        if (enabled && !supportsAutoCheckin(id)) continue
        providers[id] = { ...(providers[id] ?? defaultProviderDoc()), enabled }
        if (enabled) touched.push(id)
      }
      doc = { ...doc, providers }
      await deps.store.save(doc)
      if (touched.length > 0) void runIfDue(touched)
      return state()
    },
    /** ⚠️ 兼容旧 UI：把所有渠道的时间都设成 `time`，见接口注释。**新代码不要调用**。 */
    async setAllTimes(time) {
      let inPool: string[] = []
      try {
        inPool = [...new Set(await deps.listProviderIds())].sort()
      } catch (error) {
        deps.warn?.(`[channel-pack] 自动签到：读取账号池失败，无法批量改时间: ${String(error)}`)
        return state()
      }
      // 以账号池为范围（理由同 setAllEnabled）：只改已有条目会让全新安装时改不动。
      const providers = { ...doc.providers }
      for (const id of inPool) {
        providers[id] = { ...(providers[id] ?? defaultProviderDoc()), time }
      }
      doc = { ...doc, providers }
      await deps.store.save(doc)
      const enabledIds = inPool.filter((id) => providers[id]?.enabled === true && supportsAutoCheckin(id))
      if (enabledIds.length > 0) void runIfDue(enabledIds)
      return state()
    },
    start() {
      // ⚠️ 重复调用要幂等：装配层可能在热重载路径上再调一次，排两条周期检查
      // 会让「每 5 分钟」变成「每 2.5 分钟」两轮并发（虽然 inflight 会去重，
      // 但那是巧合而不是设计）。
      if (pending !== null || ticker !== null) return
      const ms = deps.delayMs ?? autoCheckinDelayMs()
      /**
       * 首次检查 + 转为周期检查。
       *
       * ⚠️ 首次检查仍然延迟（默认 30 秒，理由见文件头），之后**必须**转成周期
       * 检查 —— 这是本次改造的核心：旧实现只排一次 `setTimeout`，跑完就再也不醒，
       * 于是进程常驻时「第二天不签」。周期检查让「跨天」自然成立。
       */
      const fire = (): void => {
        pending = null
        // 第一次检查与后续周期共用同一条判据（runIfDue 自己判开关/时间/当天）。
        void runIfDue()
        if (ticker !== null) return
        ticker = (deps.scheduleInterval ?? defaultScheduleInterval)(() => { void runIfDue() }, tickMs)
      }
      // 延迟为 0 = 立刻跑（单测的默认形态，也是用户把环境变量设成 0 时的语义）。
      if (ms <= 0) {
        fire()
        return
      }
      pending = (deps.schedule ?? defaultSchedule)(fire, ms)
    },
    runIfDue,
    async dismiss() {
      // 记「关闭的是哪一轮」（当前的 lastAt）：下一轮跑完 lastAt 会变，文字自动回来。
      doc = { ...doc, dismissedRunAt: doc.lastAt }
      try {
        await deps.store.save(doc)
      } catch (error) {
        // 写盘失败 ⇒ 重开面板时那行文字会再出现（还可再点一次关闭），如实告警。
        deps.warn?.(`[channel-pack] 自动签到状态文字关闭标记写入失败: ${String(error)}`)
      }
      return state()
    },
    stop() {
      pending?.cancel()
      pending = null
      // ⚠️ 周期检查也必须取消：`unref()` 只是不拖住宿主退出，不代表它不再触发 ——
      // 插件被卸载后它仍会醒来跑一轮（对着已销毁的 ctx 打上游请求）。
      ticker?.cancel()
      ticker = null
    },
  }
}

/**
 * 默认排定：`setTimeout` + `unref()`。
 *
 * ⚠️ `unref()` 是必须的：否则一个 30 秒的待执行定时器会**拖住宿主进程退出**
 *（用户关掉 DSH 后进程还要多活半分钟）。与 `index.ts` 的续期定时器同一处理。
 */
function defaultSchedule(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

/**
 * 默认的**周期**排定：`setInterval` + `unref()`。
 *
 * ⚠️ `unref()` 同样必须：周期定时器若被 ref，宿主进程**永远退不出去**（每 5 分钟
 * 永远有一次待触发的 tick）—— 比一次性定时器那个「多活半分钟」严重得多。
 * ⚠️ 与 `defaultSchedule` 分开两个函数而不是加参数：`setTimeout` 与 `setInterval`
 * 的清理函数不同（`clearTimeout` / `clearInterval`），合并会让调用点必须记住传对
 * 类型，而 Node 里这两个互相混用虽然能跑（都接受 Timer 对象），但语义上容易误读。
 */
function defaultScheduleInterval(fn: () => void, ms: number): { cancel(): void } {
  const timer = setInterval(fn, ms)
  timer.unref?.()
  return { cancel: () => clearInterval(timer) }
}
