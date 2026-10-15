/**
 * dsh-model-switchboard Host 半身离线测试。
 * 用隔离的 DSH_HOME，避免污染真实开关状态。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(process.cwd(), '.dmm-test-'))
process.env.DSH_HOME = tmp

import { pathToFileURL } from 'node:url'
const mod = await import(pathToFileURL(path.join(import.meta.dirname, 'index.js')).href)

const WRAPPED = Symbol.for('dsh-model-switchboard.wrapped')
const RAW_ADAPTER = Symbol.for('dsh-model-switchboard.raw')

// ── mock 环境 ────────────────────────────────────────────────────────────

/**
 * channel-pack 式 adapter（our-free-model 的渠道实现）：get 陷阱内部再调
 * target.listModels。
 *
 * 这是回归用例：早先的实现直接覆盖 `adapter.listModels`，会与这个陷阱互相
 * 调用陷入无限递归，导致 buddy / workbuddy / lobsterai / trae 等渠道的目录
 * 在真机上全部变成 0 个模型。
 */
function channelPackAdapter(models) {
  const target = {
    async listModels() {
      return models
    },
  }
  const bound = new Map()
  const wrapOnce = (key, make) => {
    if (!bound.has(key)) bound.set(key, make())
    return bound.get(key)
  }
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'listModels' && typeof target.listModels === 'function') {
        return wrapOnce(prop, () => async (...args) => target.listModels.apply(obj, args))
      }
      const value = Reflect.get(obj, prop, receiver)
      if (typeof value !== 'function') return value
      return wrapOnce(prop, () => value.bind(obj))
    },
  })
}

const adapters = new Map([
  [
    'our-free-model',
    {
      provider: { id: 'our-free-model' },
      adapter: {
        async listModels(p) {
          return [
            { id: 'kilo-auto/free', name: 'Kilo Auto', contextWindow: 256000, maxOutput: 32768 },
            { id: 'openrouter/free', name: 'OpenRouter Free', vision: true },
            { id: 'stepfun/step-5-preview-free', name: 'Step 5' },
          ]
        },
      },
    },
  ],
  [
    'buddy',
    {
      provider: { id: 'buddy' },
      adapter: {
        async listModels() {
          return [{ id: 'hy4-preview' }, { id: 'hy3' }]
        },
      },
    },
  ],
  [
    'lobsterai',
    {
      provider: { id: 'lobsterai' },
      adapter: channelPackAdapter([
        { id: 'qwen3.8-max' },
        { id: 'kimi-k3' },
        { id: 'glm-5.3' },
      ]),
    },
  ],
])

/** 记录拓扑广播：客户端的模型目录就是靠 llm/adapters-updated 重拉的。 */
const emitLog = []

const llm = {
  adapters,
  emitAdaptersUpdated() {
    emitLog.push('llm')
  },
  async listProviders() {
    return [{ id: 'our-free-model' }, { id: 'buddy' }, { id: 'lobsterai' }]
  },
  async listModels(p) {
    const reg = adapters.get(p)
    if (!reg) return []
    return reg.adapter.listModels(p)
  },
}

let apiHandler = null
const registeredTools = {}
const ctx = {
  llm,
  tools: {
    register(def) {
      registeredTools[def.name] = def
      return () => {}
    },
  },
  webServer: {
    register(opts) {
      apiHandler = opts.handler
      return () => {}
    },
  },
  effect: (fn) => fn(),
  on: () => {},
  emit: (name) => {
    emitLog.push(name)
  },
  logger: { warn: () => {}, debug: () => {} },
}

// ── 测试工具 ─────────────────────────────────────────────────────────────
function makeRes() {
  const out = { code: null, headers: null, body: '' }
  return {
    writeHead(code, headers) {
      out.code = code
      out.headers = headers
    },
    end(body) {
      out.body = body || ''
    },
    _out: out,
  }
}
function makeReq(method, url, payload) {
  const req = { method, url }
  req[Symbol.asyncIterator] = async function* () {
    if (payload !== undefined) yield Buffer.from(JSON.stringify(payload))
  }
  return req
}
const call = async (method, url, payload) => {
  const res = makeRes()
  await apiHandler(makeReq(method, url, payload), res)
  return { code: res._out.code, json: res._out.body ? JSON.parse(res._out.body) : null }
}

let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`)
  }
}

// ── 执行 ─────────────────────────────────────────────────────────────────
console.log('== apply ==')
mod.apply(ctx)
check('工具已注册', Object.keys(registeredTools).sort().join(',') === 'dmm_probe,list_models', Object.keys(registeredTools))
check('API 已注册', typeof apiHandler === 'function')
check('三个 adapter 均已包装', ['our-free-model', 'buddy', 'lobsterai'].every((k) => adapters.get(k).adapter[WRAPPED] === true))
check('原 adapter 未被改写', adapters.get('lobsterai').adapter[RAW_ADAPTER][WRAPPED] !== true)

console.log('\n== 初始（无开关） ==')
let ofm = await llm.listModels('our-free-model')
check('our-free-model 3 个模型', ofm.length === 3, ofm.map((m) => m.id))
check('buddy 2 个模型', (await llm.listModels('buddy')).length === 2)
// 回归：channel-pack 式 Proxy 若被直接改写会无限递归，这里必须正常返回 3 个
const lobster = await llm.listModels('lobsterai')
check('channel-pack 渠道不递归（3 个模型）', lobster.length === 3, lobster.map((m) => m.id))
check('原 adapter 直接调用仍正常', (await adapters.get('lobsterai').adapter[RAW_ADAPTER].listModels('lobsterai')).length === 3)

console.log('\n== /state 应该看到未过滤的全量目录 ==')
let st = await call('GET', '/api/dsh-model-switchboard/state')
check('HTTP 200', st.code === 200, st.code)
check('三个 provider', st.json.providers.length === 3, st.json.providers.map((p) => p.id))
check('模型总数 8', st.json.stats.models === 8, st.json.stats)
check('初始无隐藏', st.json.stats.hiddenModels === 0 && st.json.stats.hiddenProviders === 0, st.json.stats)

console.log('\n== 关闭单个模型 ==')
let r = await call('POST', '/api/dsh-model-switchboard/toggle', { provider: 'our-free-model', model: 'openrouter/free' })
check('toggle 200', r.code === 200, r.code)
ofm = await llm.listModels('our-free-model')
check('该模型已从运行时目录消失', !ofm.some((m) => m.id === 'openrouter/free'), ofm.map((m) => m.id))
check('其余模型保留', ofm.length === 2, ofm.map((m) => m.id))
check('buddy 未受影响', (await llm.listModels('buddy')).length === 2)
check('切换后广播了 llm/adapters-updated', emitLog.length === 1, emitLog)

console.log('\n== 面板仍能看到被关闭的模型 ==')
st = await call('GET', '/api/dsh-model-switchboard/state')
const ofmPanel = st.json.providers.find((p) => p.id === 'our-free-model')
check('面板显示全部 3 个', ofmPanel.models.length === 3, ofmPanel.models.map((m) => m.id))
check('被关闭项标记 disabled', ofmPanel.models.find((m) => m.id === 'openrouter/free').disabled === true)
check('统计隐藏 1 个模型', st.json.stats.hiddenModels === 1, st.json.stats)

console.log('\n== 整组关闭 provider ==')
r = await call('POST', '/api/dsh-model-switchboard/toggle', { provider: 'buddy' })
check('toggle 200', r.code === 200, r.code)
check('buddy 目录已清空', (await llm.listModels('buddy')).length === 0)
check('our-free-model 不受影响', (await llm.listModels('our-free-model')).length === 2)
check('整组关闭也广播', emitLog.length === 2, emitLog)

console.log('\n== 持久化 ==')
const statePath = path.join(tmp, 'dsh-model-switchboard', 'disabled.json')
check('状态文件已写入', fs.existsSync(statePath))
const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
check('providers 含 buddy', saved.providers.includes('buddy'), saved)
check('models 含 openrouter', (saved.models['our-free-model'] || []).includes('openrouter/free'), saved)

console.log('\n== 重复 apply（幂等，模拟重启） ==')
const llm2 = {
  emitAdaptersUpdated() {
    emitLog.push('llm')
  },
  adapters: new Map([
    ['our-free-model', { provider: { id: 'our-free-model' }, adapter: { async listModels() { return [{ id: 'openrouter/free' }, { id: 'x' }] } } }],
    ['buddy', { provider: { id: 'buddy' }, adapter: { async listModels() { return [{ id: 'hy4-preview' }] } } }],
  ]),
  async listProviders() {
    return [{ id: 'our-free-model' }, { id: 'buddy' }]
  },
  async listModels(p) {
    const reg = this.adapters.get(p)
    return reg ? reg.adapter.listModels(p) : []
  },
}
const tools2 = {}
ctx.llm = llm2
ctx.tools = { register: (d) => ((tools2[d.name] = d), () => {}) }
mod.apply(ctx)
check('重启后状态被读回并生效', (await llm2.listModels('buddy')).length === 0)
const ofm2 = await llm2.listModels('our-free-model')
check('重启后单模型开关仍生效', ofm2.map((m) => m.id).join(',') === 'x', ofm2.map((m) => m.id))

console.log('\n== 全部恢复 ==')
r = await call('POST', '/api/dsh-model-switchboard/reset')
check('reset 200', r.code === 200, r.code)
check('统计归零', r.json.stats.hiddenModels === 0 && r.json.stats.hiddenProviders === 0, r.json.stats)
check('buddy 恢复', (await llm2.listModels('buddy')).length === 1)
check('reset 也广播', emitLog.length === 3, emitLog)

console.log('\n== 组 / 组员联动 ==')
let g = await call('POST', '/api/dsh-model-switchboard/toggle', { provider: 'our-free-model' })
const grp = (r2) => r2.json.providers.find((p) => p.id === 'our-free-model')
let gp = grp(g)
check('关组后组员全部标为关闭', gp.models.every((m) => m.disabled === true), gp.models.map((m) => [m.id, m.disabled]))
check('关组后组开关为关', gp.groupOn === false && gp.disabled === true, { on: gp.groupOn, off: gp.disabled })
check('关组后 offCount = 模型数', gp.offCount === 2, gp.offCount)

g = await call('POST', '/api/dsh-model-switchboard/toggle', { provider: 'our-free-model', model: 'x' })
gp = grp(g)
check('开启单个组员后它为开', gp.models.find((m) => m.id === 'x').disabled === false, gp.models.map((m) => [m.id, m.disabled]))
check('同组其余组员保持关闭', gp.models.find((m) => m.id === 'openrouter/free').disabled === true)
check('该组已退出整组关闭', gp.disabled === false && gp.groupOn === true, { off: gp.disabled, on: gp.groupOn })
check('组标记为部分显示', gp.partial === true, gp.partial)
const runtimeOfm = await llm2.listModels('our-free-model')
check('运行时目录只剩被开启的那个', runtimeOfm.map((m) => m.id).join(',') === 'x', runtimeOfm.map((m) => m.id))

g = await call('POST', '/api/dsh-model-switchboard/toggle', { provider: 'our-free-model' })
gp = grp(g)
check('部分态点击组开关 → 全部开启', gp.models.every((m) => m.disabled === false), gp.models.map((m) => [m.id, m.disabled]))
check('partial 标记清除', gp.partial === false, gp.partial)
check('运行时目录恢复 2 个', (await llm2.listModels('our-free-model')).length === 2)

console.log('\n== 工具输出 ==')
const out = await registeredTools.list_models.execute({})
const text = registeredTools.list_models.output.render({}, out)[0].text
check('list_models 渲染出运行时段', text.includes('运行时模型'), text.slice(0, 120))
check('list_models 含 our-free-model', text.includes('our-free-model'), text.slice(0, 200))
const probe = await registeredTools.dmm_probe.execute({})
check('probe 显示已包装 adapter', probe.wrappedAdapters >= 1, probe)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
