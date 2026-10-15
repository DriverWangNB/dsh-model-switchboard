/**
 * dsh-model-switchboard — 浏览器半身。
 *
 * 一个设置页分区（settings.section，id `dsh-model-switchboard`）：把 DSH 里所有
 * provider 的全部模型列出来，支持逐模型开关与整组开关。关闭后的模型会从
 * 所有模型选择器中消失（过滤装在 Host 的 adapter 层）。
 *
 * 手写 ModuleLoader bundle：无构建步骤，除 shell 已提供的 `react` 外无依赖。
 * 数据走插件自己的同源 /api/dsh-model-switchboard/* 路由（Host 半身注册），
 * 因为它由同一个宿主进程提供。全部颜色取自主题变量，跟随亮/暗主题。
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-switchboard',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useState, useEffect, useMemo, useCallback } = React

    var module = { exports: {} }
    var exports = module.exports

    const NS = 'settings.modelManager'
    const API = '/api/dsh-model-switchboard'
    const inject = ['slots', 'locale']

    const DICT = {
      zh: {
        nav: '模型开关',
        subtitle: '统一开关所有提供方与模型。关闭后，该模型会从全部模型选择器中消失。',
        search: '搜索提供方或模型…',
        restore: '全部恢复显示',
        refresh: '刷新',
        loading: '正在读取模型目录…',
        empty: '没有匹配的提供方。',
        providers: '提供方',
        models: '模型',
        hiddenProviders: '已关组',
        hiddenModels: '已关模型',
        groupOff: '整组关闭',
        ctx: '上下文',
        out: '输出',
        vision: '视觉',
        fail: '读取失败',
        group: '整组',
        groupHint: '关闭后此提供方的全部模型都不再出现',
        none: '该提供方当前没有播报模型',
      },
      en: {
        nav: 'Model switches',
        subtitle: 'Toggle every provider and model in one place. A hidden model disappears from all model pickers.',
        search: 'Search provider or model…',
        restore: 'Show everything',
        refresh: 'Refresh',
        loading: 'Reading model catalog…',
        empty: 'No matching provider.',
        providers: 'Providers',
        models: 'Models',
        hiddenProviders: 'Groups off',
        hiddenModels: 'Models off',
        groupOff: 'group off',
        ctx: 'context',
        out: 'output',
        vision: 'vision',
        fail: 'Load failed',
        group: 'group',
        groupHint: 'Turning this off hides every model of this provider',
        none: 'This provider reports no models right now',
      },
    }

    /* ── 数据访问 ─────────────────────────────────────────────────────── */

    async function request(pathname, options) {
      const res = await fetch(`${API}${pathname}`, options)
      const text = await res.text()
      let body
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        throw new Error(text.slice(0, 200) || `HTTP ${res.status}`)
      }
      if (!res.ok || body?.ok === false) throw new Error(body?.error ?? `HTTP ${res.status}`)
      return body
    }

    const getState = () => request('/state')
    const post = (pathname, payload) =>
      request(pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })

    /* ── 小组件 ───────────────────────────────────────────────────────── */

    const surface = {
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06))',
      borderRadius: 10,
    }

    function Switch({ on, onChange, disabled, title, partial }) {
      return h(
        'button',
        {
          type: 'button',
          disabled,
          title: title ?? (on ? (partial ? '部分显示' : '显示中') : '已关闭'),
          'aria-pressed': on,
          onClick: () => {
            if (!disabled) onChange()
          },
          style: {
            flex: '0 0 auto',
            width: 38,
            height: 22,
            padding: 0,
            borderRadius: 11,
            cursor: disabled ? 'progress' : 'pointer',
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
            background: on
              ? partial
                ? 'var(--dsw-alias-state-warning-primary, #f59e0b)'
                : 'var(--dsw-alias-state-business-primary, #3b82f6)'
              : 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,.25))',
            position: 'relative',
            transition: 'background .15s ease',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 2,
            left: on ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: 'var(--dsw-alias-label-on-accent, #fff)',
            boxShadow: '0 1px 2px rgba(0,0,0,.25)',
            transition: 'left .15s ease',
          },
        }),
      )
    }

    function Stat({ label, value }) {
      return h(
        'span',
        { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.9))' } },
        `${label} `,
        h('b', { style: { color: 'var(--dsw-alias-label-primary, inherit)', fontWeight: 600 } }, String(value)),
      )
    }

    function ModelRow({ providerId, model, t, onToggle, busy }) {
      const meta = []
      if (model.contextWindow) meta.push(`${t('ctx')} ${model.contextWindow}`)
      if (model.maxTokens) meta.push(`${t('out')} ${model.maxTokens}`)
      if (model.vision) meta.push(t('vision'))
      const off = model.disabled === true
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 10px',
            borderRadius: 8,
            opacity: off ? 0.55 : 1,
            background: 'transparent',
          },
        },
        h(
          'div',
          { style: { minWidth: 0, flex: '1 1 auto' } },
          h(
            'div',
            {
              style: {
                fontSize: 13,
                color: 'var(--dsw-alias-label-primary, inherit)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textDecoration: off ? 'line-through' : 'none',
              },
              title: model.id,
            },
            model.name || model.id,
          ),
          meta.length
            ? h(
                'div',
                {
                  style: {
                    fontSize: 11,
                    marginTop: 2,
                    color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.9))',
                  },
                },
                meta.join(' · '),
              )
            : null,
        ),
        h(Switch, {
          on: !off,
          disabled: busy,
          onChange: () => onToggle({ provider: providerId, model: model.id }),
        }),
      )
    }

    function ProviderCard({ p, t, query, onToggleProvider, onToggleModel, busy }) {
      const [open, setOpen] = useState(false)
      const off = p.disabled === true
      const groupOn = p.groupOn !== false
      const partial = p.partial === true
      const q = query.trim().toLowerCase()
      const models = q
        ? p.models.filter(
            (m) =>
              (m.id || '').toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q),
          )
        : p.models
      const autoOpen = Boolean(q) && models.length > 0
      const shown = open || autoOpen

      return h(
        'div',
        { style: { ...surface, overflow: 'hidden', marginBottom: 8 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' } },
          h(
            'button',
            {
              type: 'button',
              onClick: () => setOpen((v) => !v),
              style: {
                flex: '1 1 auto',
                minWidth: 0,
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                textAlign: 'left',
                color: 'inherit',
              },
            },
            h('span', { style: { fontSize: 10, opacity: 0.6 } }, shown ? '▾' : '▸'),
            h(
              'span',
              {
                style: {
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: 'var(--dsw-alias-label-primary, inherit)',
                  textDecoration: off ? 'line-through' : 'none',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
                title: p.id,
              },
              p.id,
            ),
            h(
              'span',
              { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.9))' } },
              `${p.modelCount} ${t('models')}`,
              off
                ? ` · ${t('groupOff')}`
                : p.hiddenCount
                  ? ` · ${t('hiddenModels')} ${p.hiddenCount}`
                  : '',
            ),
          ),
          h(Switch, {
            on: groupOn,
            partial,
            disabled: busy,
            title: t('groupHint'),
            onChange: () => onToggleProvider({ provider: p.id }),
          }),
        ),
        shown
          ? h(
              'div',
              {
                style: {
                  borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18))',
                  padding: '4px 2px 6px',
                  maxHeight: 340,
                  overflowY: 'auto',
                },
              },
              models.length
                ? models.map((m) =>
                    h(ModelRow, {
                      key: m.id,
                      providerId: p.id,
                      model: m,
                      t,
                      busy,
                      onToggle: onToggleModel,
                    }),
                  )
                : h(
                    'div',
                    {
                      style: {
                        padding: '10px 12px',
                        fontSize: 12,
                        color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.9))',
                      },
                    },
                    q ? t('empty') : t('none'),
                  ),
            )
          : null,
      )
    }

    function SettingsPage({ t }) {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [query, setQuery] = useState('')

      const load = useCallback(async () => {
        try {
          setData(await getState())
          setError(null)
        } catch (e) {
          setError(e?.message ?? String(e))
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const mutate = useCallback(async (pathname, payload) => {
        setBusy(true)
        try {
          setData(await post(pathname, payload))
          setError(null)
        } catch (e) {
          setError(e?.message ?? String(e))
        } finally {
          setBusy(false)
        }
      }, [])

      const toggleProvider = useCallback(
        (body) => mutate('/toggle', body),
        [mutate],
      )
      const toggleModel = useCallback((body) => mutate('/toggle', body), [mutate])
      const restoreAll = useCallback(() => mutate('/reset'), [mutate])

      const providers = data?.providers ?? []
      const q = query.trim().toLowerCase()
      const visible = useMemo(() => {
        if (!q) return providers
        return providers.filter(
          (p) =>
            p.id.toLowerCase().includes(q) ||
            p.models.some(
              (m) =>
                (m.id || '').toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q),
            ),
        )
      }, [providers, q])

      const stats = data?.stats
      const hiddenTotal = (stats?.hiddenProviders ?? 0) + (stats?.hiddenModels ?? 0)

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 } },
        h(
          'div',
          { style: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.95))' } },
          t('subtitle'),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('input', {
            value: query,
            onChange: (e) => setQuery(e.target.value),
            placeholder: t('search'),
            style: {
              flex: '1 1 200px',
              minWidth: 160,
              padding: '6px 10px',
              fontSize: 13,
              borderRadius: 8,
              color: 'var(--dsw-alias-label-primary, inherit)',
              background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08))',
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
              outline: 'none',
            },
          }),
          h(
            'button',
            {
              type: 'button',
              onClick: restoreAll,
              disabled: busy || hiddenTotal === 0,
              title: t('restore'),
              style: {
                padding: '6px 12px',
                fontSize: 12.5,
                borderRadius: 8,
                cursor: busy || hiddenTotal === 0 ? 'default' : 'pointer',
                opacity: busy || hiddenTotal === 0 ? 0.5 : 1,
                color: 'var(--dsw-alias-label-primary, inherit)',
                background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08))',
                border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
              },
            },
            t('restore'),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: load,
              disabled: busy,
              title: t('refresh'),
              style: {
                padding: '6px 12px',
                fontSize: 12.5,
                borderRadius: 8,
                cursor: busy ? 'default' : 'pointer',
                color: 'var(--dsw-alias-label-primary, inherit)',
                background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08))',
                border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
              },
            },
            t('refresh'),
          ),
        ),
        stats
          ? h(
              'div',
              { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
              h(Stat, { label: t('providers'), value: stats.providers }),
              h(Stat, { label: t('models'), value: stats.models }),
              h(Stat, { label: t('hiddenProviders'), value: stats.hiddenProviders }),
              h(Stat, { label: t('hiddenModels'), value: stats.hiddenModels }),
            )
          : null,
        error
          ? h(
              'div',
              {
                style: {
                  padding: '8px 10px',
                  fontSize: 12.5,
                  borderRadius: 8,
                  color: 'var(--dsw-alias-state-error-primary, #dc2626)',
                  border: '1px solid var(--dsw-alias-state-error-primary, rgba(220,38,38,.5))',
                },
              },
              `${t('fail')}：${error}`,
            )
          : null,
        h(
          'div',
          { style: { minHeight: 0, overflowY: 'auto', paddingRight: 2 } },
          data === null
            ? h(
                'div',
                { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.9))' } },
                t('loading'),
              )
            : visible.length === 0
              ? h(
                  'div',
                  { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.9))' } },
                  t('empty'),
                )
              : visible.map((p) =>
                  h(ProviderCard, {
                    key: p.id,
                    p,
                    t,
                    query,
                    busy,
                    onToggleProvider: toggleProvider,
                    onToggleModel: toggleModel,
                  }),
                ),
        ),
      )
    }

    /* ── 注册 ─────────────────────────────────────────────────────────── */

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-model-switchboard: dictionaries')
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-model-switchboard',
            order: 80,
            label: () => t('nav'),
            locale: NS,
          },
          (props) => h(SettingsPage, { ...props, t }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-model-switchboard'
    return module.exports
  },
})
