/**
 * checkpointFits() 只应省略「真图片」，不能按「键名」吞掉同名普通字段。
 *
 * 旧 replacer 把任何 key 为 image_url 或 data 的值都换成占位串，于是工具
 * JSON Schema 里叫 data / image_url 的子树被当成图片缩掉，续写请求的体积
 * 被低估，「装不下的续写」被判成「装得下」，多发一次上游必然 400 的请求
 * （cycles/C06 B-AUDIT §3）。
 *
 * 纯函数：不监听端口、不写临时文件、不 spawn 任何进程。
 * 运行：node scripts/recovery-estimate-test.mjs
 */
import { checkpointFits } from '../src/recovery.js'

const SCHEMA_PAD = 5000
const IMAGE_PAD = 100000
const WINDOW = 6000
const BUDGET = 4096
const CHECKPOINT = 'reasoning'

let failures = 0

const check = (name, payload, entry, expected, checkpoint = CHECKPOINT, budget = BUDGET) => {
  let actual
  try {
    actual = checkpointFits(payload, entry, checkpoint, budget)
  } catch (error) {
    failures++
    console.log('FAIL ' + name + ' — threw ' + (error?.message ?? error))
    return
  }
  const ok = actual === expected
  if (!ok) failures++
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ' — got ' + actual + ', want ' + expected))
}

const toolPayload = properties => ({
  model: 'm',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  tools: [{
    type: 'function',
    name: 'write_blob',
    parameters: { type: 'object', properties },
  }],
})

// FIT-1：工具 schema 里叫 data 的普通子树，必须照实计入体积。
check('FIT-1 tool-schema-data-subtree-is-counted',
  toolPayload({
    data: { type: 'object', description: 'x'.repeat(SCHEMA_PAD), properties: { n: { type: 'number' } } },
  }),
  { contextWindow: WINDOW }, false)

// FIT-2：工具 schema 里叫 image_url 的普通子树同理。
check('FIT-2 tool-schema-image-url-subtree-is-counted',
  toolPayload({
    image_url: { type: 'string', description: 'y'.repeat(SCHEMA_PAD) },
  }),
  { contextWindow: WINDOW }, false)

// FIT-3：chat 车道真图片 {type:'image_url', image_url:{url:'data:'}} 仍被省略。
check('FIT-3 chat-image-url-data-uri-still-omitted', {
  model: 'm',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(IMAGE_PAD) } },
    ],
  }],
}, { contextWindow: WINDOW }, true)

// FIT-4：messages 车道真图片 {type:'image', source:{type:'base64', data}} 仍被省略。
check('FIT-4 messages-base64-source-still-omitted', {
  model: 'm',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(IMAGE_PAD) } },
    ],
  }],
}, { contextWindow: WINDOW }, true)

// FIT-5：responses 车道真图片 {type:'input_image', image_url:'data:'} 仍被省略。
check('FIT-5 responses-input-image-still-omitted', {
  model: 'm',
  input: [{
    role: 'user',
    content: [
      { type: 'input_text', text: 'what is this?' },
      { type: 'input_image', image_url: 'data:image/png;base64,' + 'C'.repeat(IMAGE_PAD) },
    ],
  }],
}, { contextWindow: WINDOW }, true)

// FIT-6：普通对象里的 data 字段（父对象 type 不是 base64）必须计入。
check('FIT-6 plain-object-data-field-is-counted', {
  model: 'm',
  meta: { type: 'object', data: 'x'.repeat(4000) },
}, { contextWindow: WINDOW }, false)

// FIT-7：blob: URL 不是 data: 内联图片，不能被当图片省略（保守方向：计入体积）。
check('FIT-7 blob-url-is-counted', {
  model: 'm',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'blob:http://localhost/' + 'D'.repeat(4000) } },
    ],
  }],
}, { contextWindow: WINDOW }, false)

// FIT-8：contextWindow 缺失或非有限时保持既有早退（直接认为装得下）。
check('FIT-8a missing-context-window-is-a-fit', { model: 'm' }, {}, true)
check('FIT-8b non-finite-context-window-is-a-fit', { model: 'm' }, { contextWindow: Number.NaN }, true)

// FIT-9：textBytes + budget 恰好等于窗口时严格判 false（只有严格小于才放行）。
const exactPayload = {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}
const exactBytes = Buffer.byteLength(JSON.stringify(exactPayload), 'utf8')
check('FIT-9 exact-equality-is-not-a-fit',
  exactPayload, { contextWindow: exactBytes + BUDGET }, false, '', BUDGET)

console.log(failures === 0 ? '\nall recovery-estimate checks passed' : '\n' + failures + ' check(s) failed')
process.exitCode = failures === 0 ? 0 : 1
