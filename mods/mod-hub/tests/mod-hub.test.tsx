import { describe, expect, mock, test } from 'claude-code/testing'

import { build, since } from '../hooks/register'
import { cleanView, counts, DEFAULT_VIEW, viewMods } from '../shared/view'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const MODS = [
  { id: 'a@x', name: 'alpha', marketplace: 'x', description: 'draws a band', enabled: true, installedAt: '2026-10-23T10:00:00Z', commands: [{ name: 'alpha', description: 'open it' }] },
  { id: 'b@y', name: 'beta', marketplace: 'y', description: 'guards deletes', enabled: false, installedAt: '2026-09-01T00:00:00Z', commands: [] },
  { id: 'c@x', name: 'gamma', marketplace: 'x', description: 'a pane', enabled: true, installedAt: '2026-10-01T00:00:00Z', commands: [{ name: 'g1', description: '' }, { name: 'g2', description: 'spin the map' }] },
]
const CTX = { pins: ['g2'], pending: ['b@y'], now: NOW }

const INSTALLED = JSON.stringify({
  version: 2,
  plugins: {
    'snake@claude-code-mods': [{ installPath: 'C:\\c\\snake\\0.2.3', version: '0.2.3', installedAt: '2026-10-23T00:00:00Z' }],
    'mod-hub@owen-mods': [{ installPath: 'C:\\c\\mod-hub\\0.1.0', version: '0.1.0', installedAt: '2026-10-23T00:00:00Z' }],
  },
})
const COMMANDS = [
  { name: 'snake', description: 'Play', source: 'plugin', plugin: 'snake' },
  { name: 'hub', description: 'Open the hub', source: 'plugin', plugin: 'mod-hub' },
  { name: 'help', description: 'Help', source: 'builtin' },
]
const fwd = (p: string) => p.replace(/\\/g, '/')

// Stands for the engine: a Windows home, the installed list, settings, a store, and a hub on 8796.
function engine(on: any, hub: { actions: unknown[]; version?: number; shutdowns?: number } = { actions: [] }) {
  const runs: string[][] = []
  const stdins: unknown[] = []
  const ran: { command: string; args?: string }[] = []
  const posted: unknown[] = []
  const toasts: string[] = []
  const store: Record<string, unknown> = {}
  const clock = mock.clock(on)
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('command.list', () => ({ value: COMMANDS }))
  on('command.run', (_$: any, e: any) => (ran.push({ command: e.command, args: e.args }), { text: 'ok' }))
  on('session.version', () => ({ value: { version: '2.1.308' } }))
  on('settings.read', () => ({ value: { 'snake@claude-code-mods': true } }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : e.name === 'CLAUDE_CODE_EXECPATH' ? 'C:\\claude\\claude.exe' : undefined }))
  on('fs.read', (_$: any, e: any) => {
    const p = fwd(e.path)
    if (p.endsWith('/plugins/installed_plugins.json')) return { value: INSTALLED }
    if (p.endsWith('/mod-hub/server.json')) return { value: JSON.stringify({ port: 8796, token: 't0k', pid: 1 }) }
    if (p.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ description: `about ${p.split('/').at(-4)}` }) }
    return { value: '' }
  })
  on('fs.exists', () => ({ value: false }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_$: any, e: any) => (runs.push(e.argv), stdins.push(e.init?.stdin), { value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.copy', () => ({ value: { isCopied: false, reason: 'no-clipboard' } })) // the desktop has no clipboard path yet
  on('http.fetch', (_$: any, e: any) => {
    if (e.url.endsWith('/api/ping')) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, app: 'mod-hub', pid: 1, version: hub.version ?? 2 }) } }
    if (e.url.endsWith('/api/shutdown')) return (hub.shutdowns = (hub.shutdowns ?? 0) + 1, (hub.version = 2), { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } })
    if (e.url.includes('/api/state')) return (posted.push(JSON.parse(e.init?.body ?? 'null')), { value: { status: 200, ok: true, headers: {}, text: '{}' } })
    if (e.url.includes('/api/actions')) {
      const after = Number(new URL(e.url).searchParams.get('after'))
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ actions: hub.actions.filter((a: any) => a.seq > after) }) } }
    }
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'below' }))
  return { runs, stdins, ran, posted, toasts, store, clock }
}

describe('view', () => {
  test('filters, counts and sorts the way the pane and the hub show them', () => {
    const names = (v: Partial<typeof DEFAULT_VIEW>) => viewMods(MODS, { ...DEFAULT_VIEW, ...v }, CTX).map(m => m.name)
    expect(names({})).toEqual(['alpha', 'gamma', 'beta']) // on first, then by name
    expect(names({ filter: 'off' })).toEqual(['beta'])
    expect(names({ filter: 'pinned' })).toEqual(['gamma'])
    expect(names({ filter: 'changed' })).toEqual(['beta'])
    expect(names({ filter: 'new' })).toEqual(['alpha']) // installed two hours ago
    expect(names({ source: 'x', sort: 'commands' })).toEqual(['gamma', 'alpha'])
    expect(names({ query: 'spin map' })).toEqual(['gamma']) // every word, matched in a command's description
    expect(names({ query: '/g1' })).toEqual(['gamma'])
    expect(names({ sort: 'newest' })).toEqual(['alpha', 'gamma', 'beta'])
    expect(counts(MODS, { ...DEFAULT_VIEW, source: 'x' }, CTX)).toEqual({ all: 2, on: 2, off: 0, pinned: 1, commands: 2, changed: 0, new: 1 })
  })

  test('a stored view keeps only what it knows', () => {
    expect(cleanView({ filter: 'pinned', sort: 'bogus', source: 'x', extra: 1 })).toEqual({ query: '', filter: 'pinned', sort: 'status', source: 'x' })
    expect(cleanView(null)).toEqual(DEFAULT_VIEW)
    expect(since('2026-10-23T09:00:00Z', NOW)).toBe('3 h ago')
  })
})

describe('mod-hub', () => {
  test('build: each plugin with its commands, on unless switched off, itself marked', () => {
    const s = build(
      COMMANDS as any,
      [
        { id: 'snake@claude-code-mods', name: 'snake', marketplace: 'claude-code-mods', version: '1', installedAt: '', description: '' },
        { id: 'heatmap@claude-code-mods', name: 'heatmap', marketplace: 'claude-code-mods', version: '1', installedAt: '', description: '' },
        { id: 'mod-hub@owen-mods', name: 'mod-hub', marketplace: 'owen-mods', version: '1', installedAt: '', description: '' },
      ],
      { 'heatmap@claude-code-mods': false },
      ['snake'],
      [],
    )
    expect(s.mods.map(m => [m.name, m.enabled])).toEqual([['mod-hub', true], ['snake', true], ['heatmap', false]]) // on first, then by name
    expect(s.mods.find(m => m.name === 'snake')?.commands.map(c => c.name)).toEqual(['snake'])
    expect(s.mods.find(m => m.name === 'mod-hub')?.isSelf).toBe(true)
    expect(s.otherCommands).toEqual([{ name: 'help', description: 'Help', source: 'builtin' }])
  })

  test('the bar: Mods, Hub and each pinned command the session has', async ($, on) => {
    const { ran, store } = engine(on)
    store.pins = ['snake', 'gone-command']
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\repo' } as any)
    const bar = await $.ui.mount({ plugin: 'mod-hub', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 120 } } as any)
    expect(await bar.find({ type: 'Button', key: 'mods' })).toBeDefined()
    expect(await bar.find({ type: 'Button', key: 'hub' })).toBeDefined()
    expect(await bar.find({ type: 'Button', key: 'pin-snake' })).toBeDefined()
    expect(await bar.find({ type: 'Button', key: 'pin-gone-command' })).toBeUndefined() // a pin whose command left stays hidden
    await bar.press({ key: 'pin-snake' })
    expect(ran).toEqual([{ command: 'snake', args: '' }])
    await bar.unmount()
  })

  test('the pane turns a mod off through the running Claude Code, and offers a reload', async ($, on) => {
    const { runs, ran, toasts } = engine(on)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\repo' } as any)
    await $.command.run({ command: 'mod-manager', args: '' } as any)
    const pane = await $.ui.mount({ plugin: 'mod-hub', surface: 'desktop', component: 'Pane', requestId: 'mod-hub', props: { title: 'Mod Manager', isFocused: true, bodyColumns: 90, placement: 'dock' } } as any)
    expect(await pane.find({ type: 'Button', key: 'flip-mod-hub@owen-mods' })).toBeUndefined() // never itself
    await pane.press({ key: 'flip-snake@claude-code-mods' })
    expect(runs).toContainEqual(['C:\\claude\\claude.exe', 'plugin', 'disable', 'snake@claude-code-mods'])
    expect(toasts).toContain('snake turned off. Reload to apply')
    await pane.press({ key: 'reload' })
    expect(ran.map(r => r.command)).toContain('reload-plugins')
    await pane.unmount()
  })

  test('the pane filters with counted chips, remembers the view, and resets it', async ($, on) => {
    const { store } = engine(on)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\repo' } as any)
    await $.command.run({ command: 'mod-manager', args: '' } as any)
    const PANE = { plugin: 'mod-hub', surface: 'desktop', component: 'Pane', requestId: 'mod-hub', props: { title: 'Mod Manager', isFocused: true, bodyColumns: 90, placement: 'dock' } }
    const pane = await $.ui.mount(PANE as any)
    expect(await pane.find({ type: 'Button', key: 'filter-on' })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'filter-off' })).toBeUndefined() // nothing is off: no empty chip
    expect(await pane.find({ type: 'Button', key: 'reset' })).toBeUndefined()
    await pane.press({ key: 'filter-commands' })
    expect((store.view as any).view.filter).toBe('commands')
    expect(await pane.find({ type: 'Button', key: 'reset' })).toBeDefined()
    await pane.press({ key: 'layout' })
    expect((store.view as any).compact).toBe(true)
    await pane.press({ key: 'reset' })
    expect((store.view as any).view.filter).toBe('all')
    await pane.unmount()
  })

  test('Click: Copy copies instead of running, falls back to clip, and this mod leads, marked', async ($, on) => {
    const { runs, stdins, ran, toasts, store } = engine(on)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\repo' } as any)
    await $.command.run({ command: 'mod-manager', args: '' } as any)
    const pane = await $.ui.mount({ plugin: 'mod-hub', surface: 'desktop', component: 'Pane', requestId: 'mod-hub', props: { title: 'Mod Manager', isFocused: true, bodyColumns: 90, placement: 'dock' } } as any)
    expect(await pane.find({ type: 'Text', text: /THIS MOD/ })).toBeDefined()
    const root: any = await pane.drawn()
    const cards = JSON.stringify(root).match(/"key":"mod-[^"]+"/g) ?? []
    expect(cards[0]).toBe('"key":"mod-mod-hub@owen-mods"') // first, whatever the sort says
    await pane.press({ key: 'click-mode' })
    expect((store.view as any).clickMode).toBe('copy')
    await pane.press({ key: 'run-snake' })
    expect(ran.some(r => r.command === 'snake')).toBe(false) // copied, not run
    expect(runs).toContainEqual(['clip'])
    expect(stdins).toContain('/snake')
    expect(toasts).toContain('Copied /snake: paste it into the prompt')
    await pane.press({ key: 'alt-snake' }) // the ▶ beside it still runs
    expect(ran.some(r => r.command === 'snake')).toBe(true)
    await pane.unmount()
  })

  test('a command pressed mid-turn says it is queued', async ($, on) => {
    const { toasts, ran, store } = engine(on)
    store.pins = ['snake']
    on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\repo' } as any)
    await $.turn.start({ text: 'work', turnId: 't1' } as any)
    const bar = await $.ui.mount({ plugin: 'mod-hub', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 120 } } as any)
    expect(await bar.find({ type: 'Text', text: '▣ mods' })).toBeDefined() // the bar's own labelled panel
    await bar.press({ key: 'pin-snake' })
    expect(toasts).toContain('/snake is queued: it runs as soon as Claude finishes this turn')
    expect(ran.map(r => r.command)).toContain('snake') // handed to the engine, which runs it after the turn
    await bar.unmount()
  })

  test('a hub left running from an older version is shut down and started anew', async ($, on) => {
    const hub = { actions: [] as unknown[], version: 1 }
    const { runs, clock } = engine(on, hub)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\repo' } as any)
    for (let i = 0; i < 8; i++) await clock.advance(300) // the connect at start runs in the background
    expect((hub as any).shutdowns).toBe(1)
    expect(runs.some(a => a[0] === 'powershell' && a.some(x => x.includes('hub.mjs')))).toBe(true) // the new server
  })

  test('hub actions: known commands run, unknown ones and itself are refused, pins are kept', async ($, on) => {
    const hub = {
      actions: [
        { seq: 1, type: 'run', command: 'snake' },
        { seq: 2, type: 'run', command: 'not-a-command' },
        { seq: 3, type: 'toggle', id: 'mod-hub@owen-mods', on: false },
        { seq: 4, type: 'pins', pins: ['hub', 'snake', 'has space'] },
      ],
    }
    const { ran, runs, posted, store, clock } = engine(on, hub)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\repo' } as any)
    await clock.advance(1_600) // one tick: connected at start, so it sends state and runs the queue
    expect(ran).toEqual([{ command: 'snake', args: '' }])
    expect(runs.some(a => a.includes('disable'))).toBe(false)
    expect(store.pins).toEqual(['hub', 'snake'])
    expect(posted.length).toBeGreaterThan(0)
    expect((posted[0] as any).mods.map((m: any) => m.name)).toContain('snake')
    await clock.advance(1_600) // the same actions are not run twice
    expect(ran).toHaveLength(1)
  })
})
