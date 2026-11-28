import readline from 'node:readline'
import { startStandalone } from '../standalone/service.mjs'

// 桌面壳只控制自己启动的服务；stdin 关闭表示父进程已经离开。
let service
let closing
let parentGone = false
const input = readline.createInterface({ input: process.stdin })
const stop = () => {
  parentGone = true
  if (closing || !service) return closing
  closing = service.close().catch(() => { process.exitCode = 1 }).finally(() => {
    input.close()
    process.stdin.destroy()
  })
  return closing
}
// A parent that has gone away cannot receive another response; close the
// service cleanly instead of crashing on an unhandled stdout EPIPE.
process.stdout.on('error', () => { void stop() })
input.on('line', line => {
  if (line === 'shutdown') { void stop(); return }
  if (parentGone || closing || line.length > 1024) return
  let request
  try { request = JSON.parse(line) } catch { return }
  if (request?.protocol !== 'ofm-desktop-command/v1' || request.command !== 'bootstrap' ||
      typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.requestId)) return
  const response = { protocol: 'ofm-desktop-bootstrap/v1', requestId: request.requestId,
    product: service?.product, pid: process.pid, port: service?.port }
  try {
    if (!service) throw new Error('Not ready')
    response.managementUrl = service.createManagementBootstrap()
  } catch {
    // Correlation IDs are bounded above; never echo errors, keys, or input.
    response.code = service ? 'BOOTSTRAP_FAILED' : 'NOT_READY'
  }
  process.stdout.write(JSON.stringify(response) + '\n')
})
input.on('close', () => { void stop() })
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

try {
  const args = process.argv.slice(2)
  const options = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-refresh') options.refresh = false
    else if (args[i] === '--data-dir' && args[i + 1]) options.dataDir = args[++i]
    else if (args[i] === '--port' && /^\d+$/.test(args[i + 1] ?? '')) options.port = Number(args[++i])
    else throw new Error('桌面服务启动参数无效')
  }
  service = await startStandalone(options)
  if (parentGone) await stop()
  else process.stdout.write(JSON.stringify({
    protocol: 'ofm-desktop-ready/v1', product: service.product, pid: process.pid,
    port: service.port, managementUrl: service.managementUrl,
  }) + '\n')
} catch (error) {
  // 仅传递错误码，启动信息不会泄漏账号、API Key 或登录令牌。
  process.stdout.write(JSON.stringify({ protocol: 'ofm-desktop-error/v1',
    code: error?.code === 'EEXIST' ? 'DATA_DIRECTORY_IN_USE' : 'START_FAILED' }) + '\n')
  process.exitCode = 1
  input.close()
  process.stdin.destroy()
}
