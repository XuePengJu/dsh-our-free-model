import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 独立应用凭据仓库。同步原子写入，失败冒泡；从不读取 DSH 文件。
 *
 * 凭据文件可能由**本进程之外**的写入方替换（同一数据目录被另一个渠道进程或
 * 桌面端打开，或用户手动跑了登录命令）。旧实现只在构造时读一次盘，于是
 * 「刚登录完却仍报未配置凭据」，非要重启服务才能看到新凭据。现在 resolve /
 * describe 每次读盘前先比对 mtime，只在文件真的变化时重载；本进程自己的写入
 * 直接落到内存副本，不回读。
 */
export function createCredentials(dataDir) {
  const file = path.join(dataDir, 'channel-credentials.json')
  let values = {}
  /** 上次成功读入时的 mtimeMs；`null` 表示文件不存在（空仓是合法状态）。 */
  let stamp = null
  let closed = false
  const adopt = loaded => {
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error('独立凭据文件格式错误')
    return loaded
  }
  if (fs.existsSync(file)) {
    values = adopt(JSON.parse(fs.readFileSync(file, 'utf8')))
    try { stamp = fs.statSync(file).mtimeMs } catch { stamp = null }
  }
  /**
   * 文件变了才重读。
   *
   * 写入方可能正在原子替换（tmp + rename），因此读或解析失败时**保留上一份
   * 可用副本且不推进 stamp**，下次调用会重试，直到读到稳定内容为止 —— 这样
   * 既不会因为半截文件把凭据清空，也不会每次调用都重试同一个坏文件。
   */
  const reloadIfChanged = () => {
    if (closed) return
    let next
    try { next = fs.statSync(file).mtimeMs } catch {
      if (stamp === null) return
      stamp = null
      values = {}
      return
    }
    if (next === stamp) return
    let parsed
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return }
    values = adopt(parsed)
    stamp = next
  }
  const key = ref => {
    if (typeof ref !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(ref)) throw new TypeError('凭据引用无效')
    return ref
  }
  const save = next => {
    if (closed) throw new Error('凭据仓库已停止')
    const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
    try {
      fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' })
      fs.renameSync(temp, file)
      values = next
      try { stamp = fs.statSync(file).mtimeMs } catch { stamp = null }
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
  }
  return {
    async resolve(ref) {
      reloadIfChanged()
      const value = values[key(ref)]
      return typeof value === 'string' ? { value, source: 'local' } : undefined
    },
    async describe(ref) {
      reloadIfChanged()
      return { source: typeof values[key(ref)] === 'string' ? 'local' : undefined }
    },
    async set(ref, value) {
      if (typeof value !== 'string') throw new TypeError('凭据必须为字符串')
      save({ ...values, [key(ref)]: value })
    },
    async unset(ref) {
      const next = { ...values }
      delete next[key(ref)]
      save(next)
    },
    dispose() { closed = true; values = {} },
  }
}
