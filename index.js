/**
 * dsh-model-switchboard — 统一管理 DSH 里所有模型：查看、开关。
 *
 * 两个半身：
 *   Host（本文件）——汇总各 provider 的模型目录，并按用户开关过滤；
 *   Client（./client.js）——设置页「模型开关」分区，逐模型 / 整组开关。
 *
 * 为什么需要它：内置 Models 设置页管不到动态注册的路由。其文档明言
 * 「未附带可配置提供方声明即注册的路由没有 settings 地址；它在各选择器中
 * 仍然可见，但不会出现在本页的行里」——buddy、our-free-model、lobsterai
 * 这类渠道插件全是动态注册的，所以内置页里根本没有它们的行。
 *
 * 过滤发生在 adapter 层：dsh-llm 的 `adapters` 是公开的 Map（providerId →
 * registration），listModels 的实现是 `registration.adapter.listModels(provider)`，
 * 而模型选择器读的正是这份目录（会话控制器的 buildModelCatalog）。因此包装
 * adapter.listModels，就能让被关闭的模型从所有选择器中消失。
 *
 * 契约依据：`tools` 必须写进 inject（对齐 @michengai/dsh-skills-manager），
 * 服务就绪后 Cordis 才调用 apply；Client 半身走手写 ModuleLoader bundle
 * （对齐 dsh-our-free-model/client.js），无需构建步骤。
 */

import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

export const name = 'dsh-model-switchboard'
export const inject = ['tools', 'llm', 'webServer']

const CONFIG_FILE = 'cordis.yml'
const PROVIDER_PLUGIN = '@deepseek-ai/dsh-llm-pi-ai'
const API_PREFIX = '/api/dsh-model-switchboard'

/** 包装标记：每个 registration 只包装一次。 */
const WRAPPED = Symbol.for('dsh-model-switchboard.wrapped')
/** 从包装后的 adapter 取回原 adapter（面板要显示被关闭的条目，须读未过滤目录）。 */
const RAW_ADAPTER = Symbol.for('dsh-model-switchboard.raw')

/* ────────────────────────────── 路径与状态 ────────────────────────────── */

/** DSH 主目录：环境变量优先，宿主未导出时回落到 ~/.dsh（与 dsh-shared 同契约）。 */
function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env) return env
  return path.join(homedir(), '.dsh')
}

/**
 * profile 目录。
 *
 * 宿主进程实测不导出 DSH_HOME，因此不能只依赖环境变量：先问 config 服务，
 * 再按候选 profile 名（env → --profile → desktop）探测，最后扫描 profiles
 * 目录挑一个含 cordis.yml 的。
 */
function profileDir(ctx) {
  let p
  try {
    p = ctx?.config?.profileDir
  } catch {
    p = undefined
  }
  if (typeof p === 'string' && p) return p

  const base = path.join(dshHome(), 'profiles')
  const pi = process.argv.indexOf('--profile')
  const candidates = [process.env.DSH_PROFILE, pi !== -1 ? process.argv[pi + 1] : null, 'desktop']
  for (const nm of candidates) {
    if (typeof nm !== 'string' || !nm) continue
    const dir = path.join(base, nm)
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir
  }
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(base, entry.name)
      if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir
    }
  } catch {
    // profiles 目录不可读
  }
  return ''
}

/** 开关状态文件：整组关闭的 provider + 单独关闭的模型。 */
function stateFile() {
  return path.join(dshHome(), 'dsh-model-switchboard', 'disabled.json')
}

function emptyState() {
  return { version: 1, providers: [], models: {} }
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    const providers = Array.isArray(parsed?.providers)
      ? parsed.providers.filter((x) => typeof x === 'string' && x)
      : []
    const models = {}
    if (parsed?.models && typeof parsed.models === 'object') {
      for (const [k, v] of Object.entries(parsed.models)) {
        if (!Array.isArray(v)) continue
        const ids = v.filter((x) => typeof x === 'string' && x)
        if (ids.length) models[k] = ids
      }
    }
    return { version: 1, providers, models }
  } catch {
    return emptyState()
  }
}

/** 原子写：临时文件 + rename，避免宿主运行中写坏状态。 */
function saveState(state) {
  const file = stateFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/* ────────────────────────────── 过滤逻辑 ────────────────────────────── */

/** 按状态过滤某 provider 的模型目录。整组关闭时返回空数组，该 provider 从选择器消失。 */
function filterModels(providerId, models, state) {
  if (!Array.isArray(models)) return models
  const pid = String(providerId ?? '')
  if (state.providers.includes(pid)) return []
  const hidden = state.models[pid]
  if (!Array.isArray(hidden) || hidden.length === 0) return models
  const dead = new Set(hidden)
  const kept = models.filter((m) => !dead.has(m?.id))
  return kept.length === models.length ? models : kept
}

/**
 * 把过滤装到 adapter 层。幂等：每个 registration 只包装一次，之后仅通过
 * getState() 读取最新开关，因此用户切换后无需重新包装，下一次目录查询立刻生效。
 *
 * **不能改写原 adapter 的 listModels**：our-free-model 的 channel-pack 会把
 * adapter 包成 Proxy，其 get 陷阱内部再调 `target.listModels`。若我们覆盖
 * `adapter.listModels`，保存的「原始引用」与被覆盖的方法会互相调用，陷入
 * 无限递归——实测 buddy / workbuddy / lobsterai / trae 等渠道全部返回空。
 * 改为包一层**新的** Proxy 并只替换 registration 上的 adapter 字段，原 adapter
 * 保持原样，因此 Proxy 链上没有任何自引用。
 */
function installFilters(ctx, getState) {
  let wrappedAdapters = 0
  const adapters = ctx.llm?.adapters
  if (!adapters || typeof adapters[Symbol.iterator] !== 'function') {
    return { wrappedAdapters: 0 }
  }

  for (const [id, reg] of adapters) {
    const adapter = reg?.adapter
    if (!adapter) continue

    let already = false
    try {
      already = adapter[WRAPPED] === true
    } catch {
      already = false
    }
    if (already) {
      wrappedAdapters += 1
      continue
    }

    const wrapped = new Proxy(adapter, {
      get(target, prop) {
        if (prop === WRAPPED) return true
        if (prop === RAW_ADAPTER) return target
        if (prop === 'listModels') {
          const fn = target.listModels
          if (typeof fn !== 'function') return undefined
          return function (p) {
            const provider = String(p ?? id ?? '')
            return Promise.resolve(fn.call(target, p)).then((list) =>
              filterModels(provider, list, getState()),
            )
          }
        }
        if (prop === 'listAllModels') {
          const fn = target.listAllModels
          if (typeof fn !== 'function') return undefined
          return function (p) {
            const provider = String(p ?? id ?? '')
            return filterModels(provider, fn.call(target, p), getState())
          }
        }
        return Reflect.get(target, prop, target)
      },
    })

    try {
      reg.adapter = wrapped
      wrappedAdapters += 1
    } catch {
      // registration 冻结：跳过该 provider
    }
  }

  return { wrappedAdapters }
}

/* ────────────────────────────── 数据读取 ────────────────────────────── */

function parsePositive(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function readModelFields(entry) {
  if (!entry || typeof entry !== 'object') return null
  const id = typeof entry.id === 'string' ? entry.id : null
  if (!id) return null
  return {
    id,
    name: typeof entry.name === 'string' ? entry.name : id,
    contextWindow: parsePositive(entry.contextWindow),
    // 运行时目录用 maxOutput，配置文件用 maxTokens，两者都要认
    maxTokens: parsePositive(entry.maxTokens) ?? parsePositive(entry.maxOutput),
    vision: entry.vision === true || null,
    reasoning: entry.reasoning === true || Array.isArray(entry.reasoningEfforts) || null,
  }
}

/**
 * Load the YAML parser.
 *
 * `yaml` ships CommonJS, so a bare `import 'yaml'` resolves to no usable
 * `parse` under ESM. `createRequire` anchored at this package works whether the
 * profile hoists the dependency or installs it beside us.
 */
function loadYamlParser() {
  const candidates = [
    new URL('./package.json', import.meta.url),
    path.join(process.cwd(), 'package.json'),
  ]
  for (const base of candidates) {
    try {
      const require = createRequire(base)
      const mod = require('yaml')
      if (typeof mod?.parse === 'function') return mod.parse
    } catch {
      // try the next anchor
    }
  }
  return null
}

/** 配置层：cordis.yml 里 llm-pi-ai 的 providers（不经过滤，用于对照）。 */
function readConfiguredProviders(ctx) {
  const dir = profileDir(ctx)
  if (!dir) return { providers: {}, source: null, note: '无法确定 profile 目录' }
  const file = path.join(dir, CONFIG_FILE)
  if (!fs.existsSync(file)) return { providers: {}, source: file, note: '配置文件不存在' }

  const parse = loadYamlParser()
  if (!parse) return { providers: {}, source: file, note: '缺少 yaml 解析库' }

  let doc
  try {
    // cordis.yml carries `!!js` tags the plain parser cannot resolve. They sit
    // on layers we never read, so they are noise here — keep them off stderr.
    const originalWarn = process.emitWarning
    process.emitWarning = () => {}
    try {
      doc = parse(fs.readFileSync(file, 'utf8'))
    } finally {
      process.emitWarning = originalWarn
    }
  } catch (error) {
    return { providers: {}, source: file, note: `解析失败：${error.message}` }
  }

  const layers = Array.isArray(doc) ? doc : []
  const node = layers.find((l) => l && l.name === PROVIDER_PLUGIN)
  const providers = node?.config?.providers
  if (!providers || typeof providers !== 'object') {
    return { providers: {}, source: file, note: `未找到 ${PROVIDER_PLUGIN} 的 providers 配置` }
  }

  const out = {}
  for (const [key, value] of Object.entries(providers)) {
    if (!value || typeof value !== 'object') continue
    const models = Array.isArray(value.models) ? value.models.map(readModelFields).filter(Boolean) : []
    out[key] = {
      api: typeof value.api === 'string' ? value.api : null,
      baseURL: typeof value.baseURL === 'string' ? value.baseURL : null,
      modelCount: models.length,
      models,
    }
  }
  return { providers: out, source: file, note: null }
}

/** 运行时层：各 provider adapter 实际播报的目录（已应用开关过滤）。 */
async function readRuntimeProviders(ctx) {
  const out = {}
  let note = null
  const llm = ctx?.llm ?? null
  if (!llm) return { providers: out, note: 'llm 服务不可用，跳过运行时查询' }
  try {
    const list = await llm.listProviders?.()
    for (const entry of list || []) {
      const id = typeof entry === 'string' ? entry : entry?.id ?? entry?.name
      if (!id) continue
      let models = []
      try {
        // llm.listModels 收**位置参数** provider id；传对象会被适配器当成 id。
        const found = await llm.listModels?.(id)
        models = Array.isArray(found) ? found.map(readModelFields).filter(Boolean) : []
      } catch {
        models = []
      }
      out[id] = { modelCount: models.length, models }
    }
  } catch (error) {
    note = `运行时查询失败：${error.message}`
  }
  return { providers: out, note }
}

/** 绕过过滤读某 provider 的原始模型目录（面板必须显示已关闭的条目）。 */
async function rawModelsOf(ctx, providerId) {
  const wrapped = ctx.llm?.adapters?.get?.(providerId)?.adapter
  if (!wrapped) return []
  let raw = wrapped
  try {
    raw = wrapped[RAW_ADAPTER] ?? wrapped
  } catch {
    raw = wrapped
  }
  try {
    const list = await raw.listModels?.(providerId)
    return Array.isArray(list) ? list.map(readModelFields).filter(Boolean) : []
  } catch {
    return []
  }
}

/** 管理面板快照：全部 provider + 全部模型（含已关闭）+ 开关状态。 */
async function buildPanelState(ctx, state) {
  const llm = ctx?.llm ?? null
  let ids = []
  if (llm) {
    try {
      const list = await llm.listProviders?.()
      ids = (list || [])
        .map((e) => (typeof e === 'string' ? e : e?.id ?? e?.name))
        .filter(Boolean)
    } catch {
      ids = []
    }
  }

  const providers = await Promise.all(
    ids.map(async (id) => {
      const raw = await rawModelsOf(ctx, id)
      const groupOff = state.providers.includes(id)
      const hiddenSet = new Set(state.models[id] || [])
      return {
        id,
        disabled: groupOff,
        modelCount: raw.length,
        hiddenCount: hiddenSet.size,
        // 组关闭时组员全部视为关闭（联动），而不是只看逐模型列表
        offCount: groupOff ? raw.length : hiddenSet.size,
        // 组开关：整组关闭 → 关；否则开（有部分隐藏时另给 partial 标记）
        groupOn: !groupOff,
        partial: !groupOff && hiddenSet.size > 0 && hiddenSet.size < raw.length,
        models: raw.map((m) => ({ ...m, disabled: groupOff || hiddenSet.has(m.id) })),
      }
    }),
  )
  providers.sort((a, b) => a.id.localeCompare(b.id))

  return {
    ok: true,
    state,
    providers,
    stats: {
      providers: providers.length,
      models: providers.reduce((n, p) => n + p.modelCount, 0),
      hiddenProviders: state.providers.length,
      hiddenModels: Object.values(state.models).reduce((n, v) => n + v.length, 0),
    },
  }
}

/* ────────────────────────────── HTTP API ────────────────────────────── */

const MIME = 'application/json; charset=utf-8'

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, { 'content-type': MIME, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function readJsonBody(req, limit = 512 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 开关切换核心：provider 整组 / 单个 model，两者联动。
 *
 * 语义：
 *   · 关组 → 该 provider 全部组员关闭（面板显示为全关）；
 *   · 开组 → 清掉逐模型记录，全部恢复；
 *   · 在「整组关闭」状态下单独开启某个组员 → 退出整组模式，并把该组
 *     其余模型逐个记为关闭，于是只有这一个组员和组是开着的（用户预期行为）。
 */
async function applyToggle(ctx, state, { provider, model, disabled }) {
  const pid = String(provider ?? '')
  if (!pid) throw new Error('缺少 provider')
  const next = { version: 1, providers: [...state.providers], models: { ...state.models } }
  const groupOff = next.providers.includes(pid)

  // ── 整组开关 ──────────────────────────────────────────────────────────
  if (model === undefined || model === null || model === '') {
    // 三态语义：全开 → 点击关闭；整组关闭 / 部分隐藏 → 点击全部开启
    const hasHidden = Array.isArray(next.models[pid]) && next.models[pid].length > 0
    const targetDisabled =
      typeof disabled === 'boolean' ? disabled : groupOff || hasHidden ? false : true
    if (targetDisabled) {
      // 关闭整组：整组标记优先，清掉逐模型记录，避免两套状态互相打架
      if (!groupOff) next.providers.push(pid)
      delete next.models[pid]
    } else {
      // 开启整组：全部恢复
      next.providers = next.providers.filter((x) => x !== pid)
      delete next.models[pid]
    }
    return next
  }

  // ── 单个组员 ──────────────────────────────────────────────────────────
  const mid = String(model)
  const list = Array.isArray(next.models[pid]) ? [...next.models[pid]] : []
  const effective = groupOff || list.includes(mid)
  const target = typeof disabled === 'boolean' ? disabled : !effective

  if (groupOff) {
    // 整组关闭状态下：想继续关 → 无变化；想开 → 退出整组并隐藏其余组员
    if (target) return next
    const all = await rawModelsOf(ctx, pid)
    next.providers = next.providers.filter((x) => x !== pid)
    const others = all.map((m) => m.id).filter((x) => x !== mid)
    if (others.length) next.models[pid] = others
    else delete next.models[pid]
    return next
  }

  const filtered = list.filter((x) => x !== mid)
  if (target) filtered.push(mid)
  if (filtered.length) next.models[pid] = filtered
  else delete next.models[pid]
  return next
}

/**
 * 通知 DSH 重新广播模型拓扑。
 *
 * 客户端那份「常驻模型目录」只在收到 llm/adapters-updated 时才 invalidate + 重拉
 * （见 ui-model-selection 的 ModelCatalogDirectory），否则一直用启动时缓存的那份。
 * 所以开关写完状态后必须广播，输入框上方的模型选择器才会立即反映结果 ——
 * 不广播就会出现「关了模型却没效果」。
 */
function broadcastTopology(ctx) {
  try {
    const llm = ctx.llm
    if (typeof llm?.emitAdaptersUpdated === 'function') {
      llm.emitAdaptersUpdated()
      return
    }
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-model-switchboard] emitAdaptersUpdated 调用失败：${error?.message ?? error}`)
  }
  try {
    ctx.emit('llm/adapters-updated')
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-model-switchboard] 广播 llm/adapters-updated 失败：${error?.message ?? error}`)
  }
}

function registerApi(ctx, getState, setState) {
  const handler = async (req, res) => {
    let route = '/'
    try {
      route = new URL(req.url ?? '/', 'http://localhost').pathname.slice(API_PREFIX.length) || '/'
    } catch {
      route = '/'
    }
    try {
      if (req.method === 'GET' && (route === '/' || route === '/state')) {
        return sendJson(res, 200, await buildPanelState(ctx, getState()))
      }
      if (req.method === 'POST' && route === '/toggle') {
        const next = await applyToggle(ctx, getState(), await readJsonBody(req))
        if (!saveState(next)) return sendJson(res, 500, { ok: false, error: '状态写入失败' })
        setState(next)
        broadcastTopology(ctx)
        return sendJson(res, 200, await buildPanelState(ctx, next))
      }
      if (req.method === 'POST' && route === '/bulk') {
        const body = await readJsonBody(req)
        let next = getState()
        for (const op of Array.isArray(body?.ops) ? body.ops : []) next = await applyToggle(ctx, next, op)
        if (!saveState(next)) return sendJson(res, 500, { ok: false, error: '状态写入失败' })
        setState(next)
        broadcastTopology(ctx)
        return sendJson(res, 200, await buildPanelState(ctx, next))
      }
      if (req.method === 'POST' && route === '/reset') {
        const next = emptyState()
        if (!saveState(next)) return sendJson(res, 500, { ok: false, error: '状态写入失败' })
        setState(next)
        broadcastTopology(ctx)
        return sendJson(res, 200, await buildPanelState(ctx, next))
      }
      return sendJson(res, 404, { ok: false, error: `未知路由 ${route}` })
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
    }
  }

  try {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
    return () => {
      try {
        dispose?.()
      } catch {
        // 已释放
      }
    }
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-model-switchboard] API 注册失败：${error?.message ?? error}`)
    return () => {}
  }
}

/* ────────────────────────────── 工具 ────────────────────────────── */

function filterProviders(providers, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return providers
  const out = {}
  for (const [key, value] of Object.entries(providers)) {
    const models = (value.models || []).filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    )
    if (key.toLowerCase().includes(q) || models.length > 0) {
      out[key] = { ...value, models, modelCount: models.length }
    }
  }
  return out
}

function renderText(result) {
  const lines = []
  const configured = result?.configured ?? { providers: {}, source: null }
  const runtime = result?.runtime ?? { providers: {} }
  const state = result?.state ?? emptyState()
  const query = result?.query

  lines.push(`已配置模型（来自 ${configured.source ?? '未知来源'}）`)
  if (configured.note) lines.push(`  注意：${configured.note}`)
  const cfgKeys = Object.keys(configured.providers || {})
  if (cfgKeys.length === 0) {
    lines.push('  未找到已配置的 provider。')
  } else {
    for (const key of cfgKeys) {
      const p = configured.providers[key]
      lines.push(`  ${key}（${p.modelCount} 个模型）${p.baseURL ? ` · ${p.baseURL}` : ''}`)
      for (const m of p.models || []) {
        const bits = []
        if (m.contextWindow) bits.push(`上下文 ${m.contextWindow}`)
        if (m.maxTokens) bits.push(`输出上限 ${m.maxTokens}`)
        lines.push(`    - ${m.id}${bits.length ? `  [${bits.join(' · ')}]` : ''}`)
      }
    }
  }

  lines.push('')
  lines.push('运行时模型（已应用开关过滤）')
  if (runtime.note) {
    lines.push(`  注意：${runtime.note}`)
  } else {
    const rtKeys = Object.keys(runtime.providers || {})
    if (rtKeys.length === 0) {
      lines.push('  运行时未报告任何 provider。')
    } else {
      for (const key of rtKeys) {
        const p = runtime.providers[key]
        const off = state.providers.includes(key)
        const hidden = (state.models[key] || []).length
        const mark = off ? ' · 已整组关闭' : hidden ? ` · 隐藏 ${hidden} 个` : ''
        const ids = (p.models || []).map((m) => m.id)
        lines.push(`  ${key}（${p.modelCount} 个）${mark}${ids.length ? `：${ids.join('、')}` : ''}`)
      }
    }
  }

  const hiddenModels = Object.values(state.models).reduce((n, v) => n + v.length, 0)
  if (state.providers.length || hiddenModels) {
    lines.push('')
    lines.push(
      `当前已关闭：${state.providers.length} 个 provider 整组、${hiddenModels} 个单模型。在设置页「模型开关」里调整。`,
    )
  }

  if (query) lines.push(`\n已按 "${query}" 过滤。`)
  return lines.join('\n')
}

/* ────────────────────────────── apply ────────────────────────────── */

export function apply(ctx) {
  let state = loadState()
  const getState = () => state
  const setState = (next) => {
    state = next
  }

  // 观测计数：设置页每次改动开关都会广播 llm/adapters-updated，这里记下来。
  // 它同时证明事件确实能派发到本插件的 ctx —— 客户端那份常驻模型目录
  // （ui-model-selection 的 ModelCatalogDirectory）监听的是同一个事件，这就是
  // 「关掉后输入框上方的选择器立即变干净」的依据；计数不涨说明广播没生效。
  let topologyEvents = 0

  const install = () => installFilters(ctx, getState)
  install()
  try {
    // 动态渠道插件随时注册新 adapter，增删时重装
    ctx.on?.('llm/adapters-updated', () => {
      topologyEvents += 1
      install()
    })
  } catch {
    // 事件总线不可用：仅首次安装
  }

  // HTTP API（设置页数据源）
  ctx.effect?.(() => registerApi(ctx, getState, setState))

  const register = (def) => {
    if (typeof ctx.effect === 'function') return ctx.effect(() => ctx.tools.register(def))
    return ctx.tools.register(def)
  }

  register({
    name: 'dmm_probe',
    description: '探针：确认 dsh-model-switchboard 是否被加载，并回传它看到的服务状态与过滤安装情况。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async () => {
      let providers = []
      try {
        providers = (await ctx.llm?.listProviders?.()) ?? []
      } catch {
        providers = []
      }
      const info = install()
      return {
        loaded: true,
        version: '0.3.3',
        canBroadcast: typeof ctx.llm?.emitAdaptersUpdated === 'function',
        topologyEvents,
        hasTools: typeof ctx.tools?.register === 'function',
        hasLlm: Boolean(ctx.llm),
        hasWebServer: Boolean(ctx.webServer),
        providerCount: Array.isArray(providers) ? providers.length : 0,
        adapterCount: ctx.llm?.adapters?.size ?? null,
        wrappedAdapters: info.wrappedAdapters,
        stateFile: stateFile(),
        state,
        apiPrefix: API_PREFIX,
        moduleUrl: import.meta.url,
        nodePid: process.pid,
        dshHome: dshHome(),
        profileDir: profileDir(ctx) || null,
      }
    },
  })

  register({
    name: 'list_models',
    description:
      '列出当前 DSH 里所有可用的模型，分两层展示：cordis.yml 里已配置的（含上下文窗口与输出上限），' +
      '以及运行时 provider 实际提供的（含插件动态注册的，已应用开关过滤）。支持按 provider 名或模型名过滤。' +
      '只读；开关操作在设置页「模型开关」完成。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '可选。按 provider 名或模型名（不区分大小写）过滤，留空返回全部。',
        },
        includeRuntime: {
          type: 'boolean',
          description: '是否同时查询运行时 provider 实际提供的模型，默认 true。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderText(value) }],
    },
    execute: async (args) => {
      const query = String(args?.query ?? '')
      install()
      const configured = readConfiguredProviders(ctx)
      const runtime =
        args?.includeRuntime === false
          ? { providers: {}, note: '已按请求跳过运行时查询' }
          : await readRuntimeProviders(ctx)

      const result = { query: query || null, configured, runtime, state: getState() }
      if (query) {
        result.configured = {
          ...configured,
          providers: filterProviders(configured.providers, query),
        }
        result.runtime = { ...runtime, providers: filterProviders(runtime.providers, query) }
      }
      return result
    },
    timeoutMs: 30_000,
  })
}
