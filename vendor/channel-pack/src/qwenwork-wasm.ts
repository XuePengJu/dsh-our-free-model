/**
 * 千问办公渠道 —— 官方 WASM（`qoder_auth_wasm`，1.0.4 客户端版）桥。
 *
 * ## 与 `qoder-wasm.ts` 的关系
 *
 * Qoder 与 QwenWorkCN 同源（QwenWork 桌面端就是 Qoder 的换皮），加密推理端点
 * 完全同型；但两边随包分发的 WASM **版本不同**（本渠道 288 KB / Qoder 298 KB，
 * sha256 各异），且身份材料生成方式不同（Qoder 走 WASM 的
 * `generate_runtime_auth_fields`；千问办公在 asar JS 层做 AES+RSA，见
 * `qwenwork-crypto.ts`）。为不干扰线上 Qoder 渠道，这里**独立桥接**千问办公
 * 随包的 WASM，结构照抄 qoder-wasm.ts 的 Glue（三个实测坑的注释一并保留）。
 *
 * ## 三个必须记住的坑（与 qoder-wasm.ts 相同）
 *
 * 1. **两个 `getRandomValues` import 的签名方向相反**：
 *    `_d49329ff89a07af1` 写 **wasm 内存**、`_c44a50d8cfdaebeb` 调 **JS 对象**。
 * 2. **返回值布局有两套**：字符串类为 `ptr/len/errIdx/isErr`，
 *    而 `qodercontext_new` / `prepareInferRequest` 为 `ptr/errIdx/isErr`。
 * 3. **`requestresult_url(栈指针, ptr)` 参数顺序与直觉相反**。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { QwenworkWasmUserInfo } from './qwenwork-crypto.js'
import { buildQwenworkUserInfoJson, encryptUserMaterial } from './qwenwork-crypto.js'
import { QWENWORK_COSY_VERSION } from './qwenwork.js'

/** WASM 文件（随插件分发，位于同目录）。 */
const WASM_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'qwenwork-auth-wasm.wasm')

/** 最小 `WebAssembly` 类型声明（tsconfig 无 DOM lib，同 qoder-wasm.ts）。 */
interface WasmModule {
  exports: readonly { name: string }[]
}
interface WasmMemory {
  buffer: ArrayBuffer
}
declare const WebAssembly: {
  compile(bytes: Uint8Array): Promise<unknown>
  instantiate(module: unknown, imports: Record<string, unknown>): Promise<{ exports: unknown }>
  Module: new (bytes: Uint8Array) => WasmModule
}

/** Glue 状态（沿用 wasm-bindgen 命名约定，便于与官方产物对照）。 */
interface Glue {
  exports: Record<string, (...args: number[]) => number>
  heap: () => Uint8Array
  view: () => DataView
  readString: (ptr: number, len: number) => string
  writeString: (text: string) => number
  lastLength: () => number
  heapObject: (index: number) => unknown
  pushObject: (value: unknown) => number
  takeObject: (index: number) => unknown
  callPointer: (invoke: (stack: number) => void) => number
}

let gluePromise: Promise<Glue> | null = null

async function getGlue(): Promise<Glue> {
  gluePromise ??= createGlue()
  return gluePromise
}

async function createGlue(): Promise<Glue> {
  const bytes = readFileSync(WASM_PATH)
  const module = await WebAssembly.compile(bytes)

  let exports: Record<string, (...args: number[]) => number> = {}
  let cachedHeap: Uint8Array | null = null
  let cachedView: DataView | null = null

  const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
  const encoder = new TextEncoder()

  const heap = (): Uint8Array => {
    if (cachedHeap === null || cachedHeap.byteLength === 0) {
      cachedHeap = new Uint8Array((exports.memory as unknown as WasmMemory).buffer)
    }
    return cachedHeap
  }
  const view = (): DataView => {
    if (cachedView === null || cachedView.buffer !== (exports.memory as unknown as WasmMemory).buffer) {
      cachedView = new DataView((exports.memory as unknown as WasmMemory).buffer)
    }
    return cachedView
  }
  const readString = (ptr: number, len: number): string =>
    decoder.decode(heap().subarray(ptr >>> 0, (ptr >>> 0) + len))

  // 对象堆：1024 个 undefined + 四个哨兵（与官方 wW 一致）
  const objects: unknown[] = new Array(1024).fill(undefined)
  objects.push(undefined, null, true, false)
  let firstFree = objects.length
  const heapObject = (index: number): unknown => objects[index]
  const pushObject = (value: unknown): number => {
    if (firstFree === objects.length) objects.push(objects.length + 1)
    const index = firstFree
    firstFree = objects[index] as number
    objects[index] = value
    return index
  }
  const takeObject = (index: number): unknown => {
    const value = heapObject(index)
    if (index >= 1028) {
      objects[index] = firstFree
      firstFree = index
    }
    return value
  }

  let lastLength = 0
  const writeString = (text: string): number => {
    const encoded = encoder.encode(text)
    const ptr = exports.__wbindgen_export2!(encoded.length, 1) >>> 0
    heap().subarray(ptr, ptr + encoded.length).set(encoded)
    lastLength = encoded.length
    return ptr
  }

  const callPointer = (invoke: (stack: number) => void): number => {
    const stack = exports.__wbindgen_add_to_stack_pointer!(-16)
    try {
      invoke(stack)
      const v = view()
      const ptr = v.getInt32(stack + 0, true)
      const isError = v.getInt32(stack + 8, true)
      if (isError) throw takeObject(v.getInt32(stack + 4, true))
      return ptr
    } finally {
      exports.__wbindgen_add_to_stack_pointer!(16)
    }
  }

  const guard = (fn: (...args: number[]) => void, args: number[]): void => {
    try {
      fn(...args)
    } catch (error) {
      exports.__wbindgen_export!(pushObject(error))
    }
  }

  const imports: Record<string, (...args: number[]) => unknown> = {
    __wbindgen_object_drop_ref: (a: number) => takeObject(a),
    __wbindgen_object_clone_ref: (a: number) => pushObject(heapObject(a)),
    __wbindgen_cast_0000000000000001: (a: number, e: number) =>
      pushObject(heap().subarray(a >>> 0, (a >>> 0) + e)),
    __wbindgen_cast_0000000000000002: (a: number, e: number) => pushObject(readString(a, e)),
    __wbg_set_08463b1df38a7e29: (a: number, e: number, t: number) =>
      pushObject((heapObject(a) as Uint8Array).set(heapObject(e) as Uint8Array, heapObject(t) as number)),
    // ⚠️ 两个 getRandomValues 方向相反（坑 1）
    __wbg_getRandomValues_d49329ff89a07af1: (...a: number[]) =>
      guard((x: number, y: number) => {
        globalThis.crypto.getRandomValues(heap().subarray(x >>> 0, (x >>> 0) + y))
      }, a),
    __wbg_getRandomValues_c44a50d8cfdaebeb: (...a: number[]) =>
      guard((x: number, y: number) => {
        ;(heapObject(x) as { getRandomValues: (v: unknown) => void }).getRandomValues(heapObject(y))
      }, a),
    __wbg_randomFillSync_6c25eac9869eb53c: (...a: number[]) =>
      guard((x: number, y: number) => {
        ;(heapObject(x) as { randomFillSync: (v: unknown) => void }).randomFillSync(takeObject(y))
      }, a),
    __wbg_new_99cabae501c0a8a0: () => pushObject(new Map()),
    __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
    __wbg_crypto_38df2bab126b63dc: (a: number) =>
      pushObject((heapObject(a) as { crypto: unknown }).crypto),
    __wbg_msCrypto_bd5a034af96bcba6: (a: number) =>
      pushObject((heapObject(a) as { msCrypto: unknown }).msCrypto),
    __wbg_process_44c7a14e11e9f69e: (a: number) =>
      pushObject((heapObject(a) as { process: unknown }).process),
    __wbg_versions_276b2795b1c6a219: (a: number) =>
      pushObject((heapObject(a) as { versions: unknown }).versions),
    __wbg_node_84ea875411254db1: (a: number) => pushObject((heapObject(a) as { node: unknown }).node),
    __wbg_require_b4edbdcf3e2a1ef0: (...a: number[]) =>
      guard(() => pushObject(module), a),
    __wbg_call_d578befcc3145dee: (...a: number[]) =>
      guard((fn: number, self: number, arg: number) => {
        const target = heapObject(fn) as { call: (thisArg: unknown, ...rest: unknown[]) => unknown }
        pushObject(target.call(heapObject(self), heapObject(arg)))
      }, a),
    __wbg_new_with_length_9cedd08484b73942: (a: number) => pushObject(new Uint8Array(a >>> 0)),
    __wbg_length_0c32cb8543c8e4c8: (a: number) => (heapObject(a) as { length: number }).length,
    __wbg_prototypesetcall_3e05eb9545565046: (a: number, e: number, t: number) => {
      Uint8Array.prototype.set.call(heap().subarray(a >>> 0, (a >>> 0) + e), heapObject(t) as Uint8Array)
    },
    __wbg_subarray_0f98d3fb634508ad: (a: number, e: number, t: number) =>
      pushObject((heapObject(a) as Uint8Array).subarray(e >>> 0, t >>> 0)),
    __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => pushObject(globalThis),
    __wbg_static_accessor_SELF_24f78b6d23f286ea: () =>
      (globalThis as { self?: unknown }).self === undefined ? 0 : pushObject((globalThis as { self?: unknown }).self),
    __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => pushObject(globalThis),
    __wbg_static_accessor_WINDOW_59fd959c540fe405: () =>
      (globalThis as { window?: unknown }).window === undefined ? 0 : pushObject((globalThis as { window?: unknown }).window),
    __wbg___wbindgen_throw_81fc77679af83bc6: (p: number, l: number) => {
      throw new Error(readString(p, l))
    },
    __wbg_Error_2e59b1b37a9a34c3: (p: number, l: number) => pushObject(new Error(readString(p, l))),
    __wbg___wbindgen_is_object_40c5a80572e8f9d3: (id: number) => {
      const v = heapObject(id)
      return typeof v === 'object' && v !== null ? 1 : 0
    },
    __wbg___wbindgen_is_string_b29b5c5a8065ba1a: (id: number) => (typeof heapObject(id) === 'string' ? 1 : 0),
    __wbg___wbindgen_is_function_49868bde5eb1e745: (id: number) => (typeof heapObject(id) === 'function' ? 1 : 0),
    __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (id: number) => (heapObject(id) === undefined ? 1 : 0),
  }

  const instance = await WebAssembly.instantiate(module, { ['./qoder_auth_wasm_bg.js']: imports })
  exports = instance.exports as unknown as Record<string, (...args: number[]) => number>

  return {
    exports,
    heap,
    view,
    readString,
    writeString,
    lastLength: () => lastLength,
    heapObject,
    pushObject,
    takeObject,
    callPointer,
  }
}

/** `prepareInferRequest` 的产物（与官方 `PreparedInfer` 对齐）。 */
export interface QwenworkPreparedInfer {
  /** 完整 URL（网关 + 端点 + `Encode=1`）。 */
  url: string
  /** 必须原样透传的头（含 WASM 生成的 `Authorization: Bearer COSY.…`）。 */
  headers: Record<string, string>
  /** 加密后的请求体。 */
  body: string
}

/** `qodercontext_new` 的 clientMeta（brand）JSON 结构。 */
export interface QwenworkClientMetadata {
  client_type: string
  business_product: string
  business_type: string
  scene: string
}

/**
 * 一次性打包一条加密推理请求（每请求建一个 WASM 上下文）。
 *
 * ⚠️ 返回的 `headers` 必须原样透传：`Authorization` 是 WASM 生成的
 * `Bearer COSY.<载荷>.<签名>`，用普通 Bearer 覆盖会 403（Qoder 渠道实测教训）。
 */
export async function prepareQwenworkInfer(options: {
  /** 身份四元组（进入 user_info）。 */
  uid: string
  name: string
  email: string
  accessToken: string
  /** 设备 id（`Cosy-MachineId`；无则用占位）。 */
  machineId: string
  /** 明文请求体（JSON 字符串）。 */
  body: string
  /** 模型目录 key（`qwork-advanced` 等）。 */
  modelKey: string
  /** 网关 origin（`https://gateway.qwenwork.cn`）。 */
  endpoint: string
  source?: string
}): Promise<QwenworkPreparedInfer> {
  const g = await getGlue()
  const material = encryptUserMaterial({
    uid: options.uid,
    name: options.name,
    email: options.email,
    accessToken: options.accessToken,
  })
  const userInfoJson = buildQwenworkUserInfoJson(material)
  const metadata: QwenworkClientMetadata = {
    client_type: '6',
    business_product: 'qoder_work',
    business_type: 'agent',
    scene: 'qwork',
  }

  const context = g.callPointer((stack) => {
    const machine = g.writeString(options.machineId || 'ofm-qwenwork'); const machineLen = g.lastLength()
    const ver = g.writeString(QWENWORK_COSY_VERSION); const verLen = g.lastLength()
    const info = g.writeString(userInfoJson); const infoLen = g.lastLength()
    const meta = g.writeString(JSON.stringify(metadata)); const metaLen = g.lastLength()
    // 参数顺序：(sp, machineId, len, version, len, userInfo, len, clientMeta, len)
    g.exports.qodercontext_new!(stack, machine, machineLen, ver, verLen, info, infoLen, meta, metaLen)
  })

  try {
    const source = options.source ?? 'system'
    const result = g.callPointer((stack) => {
      const host = g.writeString(options.endpoint); const hostLen = g.lastLength()
      const body = g.writeString(options.body); const bodyLen = g.lastLength()
      const key = g.writeString(options.modelKey); const keyLen = g.lastLength()
      const src = g.writeString(source); const srcLen = g.lastLength()
      g.exports.qodercontext_prepareInferRequest!(
        stack, context, host, hostLen, body, bodyLen, key, keyLen, src, srcLen,
      )
    })

    const headerMap = g.takeObject(g.exports.requestresult_headers!(result))
    const headers: Record<string, string> = {}
    if (headerMap instanceof Map) {
      for (const [k, v] of headerMap) headers[String(k)] = String(v)
    }

    const readResultString = (invoke: (stack: number, ptr: number) => void): string => {
      let out = ''
      const v = g.view()
      const stack = g.exports.__wbindgen_add_to_stack_pointer!(-16)
      try {
        invoke(stack, result)
        const ptr = v.getInt32(stack + 0, true)
        const len = v.getInt32(stack + 4, true)
        out = ptr ? g.readString(ptr, len) : ''
      } finally {
        g.exports.__wbindgen_add_to_stack_pointer!(16)
      }
      return out
    }

    return {
      // ⚠️ 参数顺序：(栈指针, ptr) —— 与直觉相反（坑 3）
      url: readResultString((stack, ptr) => g.exports.requestresult_url!(stack, ptr)),
      headers,
      body: readResultString((stack, ptr) => g.exports.requestresult_body!(stack, ptr)),
    }
  } finally {
    try {
      g.exports.__wbg_qodercontext_free!(context, 0)
    } catch {
      // 上下文释放失败不影响请求结果
    }
  }
}

/** 供测试注入/复位。 */
export const __testing = {
  resetGlue(): void {
    gluePromise = null
  },
  wasmPath: WASM_PATH,
}
