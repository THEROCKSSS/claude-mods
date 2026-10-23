import { describe, expect, mock, test } from 'claude-code/testing'

import { cleanPreset, countdown, isToggle, plan, snapshot, summary, upsert } from '../shared/presets'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const INSTALLED = JSON.stringify({
  version: 2,
  plugins: {
    'snake@claude-code-mods': [{ installPath: 'C:\\c\\snake', version: '0.2.3', installedAt: '2026-10-23T00:00:00Z' }],
    'heatmap@claude-code-mods': [{ installPath: 'C:\\c\\heatmap', version: '0.1.1', installedAt: '2026-10-23T00:00:00Z' }],
    'mod-hub@owen-mods': [{ installPath: 'C:\\c\\mod-hub', version: '0.2.0', installedAt: '2026-10-23T00:00:00Z' }],
  },
})
const COMMANDS = [
  { name: 'snake', description: 'Snake in a pane; /snake again turns it off', source: 'plugin', plugin: 'snake' },
  { name: 'heatmap', description: 'Open the heatmap', source: 'plugin', plugin: 'heatmap' },
  { name: 'hub', description: 'Open the hub', source: 'plugin', plugin: 'mod-hub' },
  { name: 'help', description: 'Help', source: 'builtin' },
]
const fwd = (p: string) => p.replace(/\\/g, '/')
const said = (r: any): string => (typeof r.result === 'string' ? r.result : typeof r.text === 'string' ? r.text : JSON.stringify(r))

// The engine beneath: a home folder, two mods plus mod-hub, settings with heatmap off, a store, no hub.
function engine(on: any) {
  const runs: string[][] = []
  const ran: { command: string; args?: string }[] = []
  const toasts: string[] = []
  const store: Record<string, unknown> = {}
  const clock = mock.clock(on, { now: NOW })
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: undefined }))
  on('command.list', () => ({ value: COMMANDS }))
  on('command.run', (_$: any, e: any) => (ran.push({ command: e.command, args: e.args }), { text: 'ok' }))
  on('session.version', () => ({ value: { version: '2.1.308' } }))
  on('settings.read', () => ({ value: { enabledPlugins: { 'heatmap@claude-code-mods': false } } })) // the whole settings: a key read is projected from it
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 10, model: 'm' } }
  })
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : e.name === 'CLAUDE_CODE_EXECPATH' ? 'C:\\claude.exe' : undefined }))
  on('fs.read', (_$: any, e: any) => (fwd(e.path).endsWith('/plugins/installed_plugins.json') ? { value: INSTALLED } : { value: '' }))
  on('fs.exists', () => ({ value: false }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('store.delete', (_$: any, e: any) => (delete store[e.key], { value: undefined }))
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_$: any, e: any) => (runs.push(e.argv), { value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('http.fetch', () => ({ value: { status: 404, ok: false, headers: {}, text: '' } }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'below' }))
  return { runs, ran, toasts, store, clock }
}
const PANE = { plugin: 'mod-hub', surface: 'desktop', component: 'Pane', requestId: 'mod-hub', props: { title: 'Mod Manager', isFocused: true, bodyColumns: 100, placement: 'dock' } }
const BAR = { plugin: 'mod-hub', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 140 } }

describe('presets, the logic', () => {
  test('a snapshot keeps every mod, the pins, and recent commands once each, toggles unticked', () => {
    const mods = [
      { id: 'snake@m', enabled: true, isSelf: false, commands: [{ name: 'snake', description: 'Snake; /snake again turns it off' }] },
      { id: 'heatmap@m', enabled: false, isSelf: false, commands: [{ name: 'heatmap', description: 'Open the heatmap' }] },
      { id: 'mod-hub@o', enabled: true, isSelf: true, commands: [] },
    ]
    const p = snapshot('Mine', mods, ['heatmap'], [
      { command: 'heatmap', args: '', at: 3 },
      { command: 'snake', args: '', at: 2 },
      { command: 'heatmap', args: '', at: 1 },
      { command: 'help', args: '', at: 0 }, // not a mod's command: left out
    ], NOW)
    expect(p.mods).toEqual({ 'snake@m': 'on', 'heatmap@m': 'off' }) // never mod-hub itself
    expect(p.steps).toEqual([{ command: 'heatmap', args: '', enabled: true }, { command: 'snake', args: '', enabled: false }])
    expect(p.pins).toEqual(['heatmap'])
    expect(plan(p, [{ id: 'snake@m', enabled: true }, { id: 'heatmap@m', enabled: false }]).flips).toEqual([]) // applying it now changes nothing
    expect(plan(p, [{ id: 'snake@m', enabled: false }, { id: 'heatmap@m', enabled: false }]).flips).toEqual([{ id: 'snake@m', on: true }])
    expect(summary(p)).toBe('1 on, 1 off · runs /heatmap · 1 pinned')
  })

  test('cleaning keeps only valid shapes; saving gives new ones an id and updates known ones', () => {
    expect(cleanPreset({ name: '' }, NOW)).toBeNull()
    const c = cleanPreset({ name: 'X', mods: { 'a@b': 'on', 'bad id!': 'on', 'c@d': 'maybe' }, steps: [{ command: '/cache-clock', args: 'setup' }, { command: 'rm -rf' }], pins: ['ok', 'not ok'] }, NOW)!
    expect(c.mods).toEqual({ 'a@b': 'on' })
    expect(c.steps).toEqual([{ command: 'cache-clock', args: 'setup', enabled: true }])
    expect(c.pins).toEqual(['ok'])
    const one = upsert([], c, NOW)
    expect(one[0]!.id).toBe('x')
    const two = upsert(one, { ...c, id: '' }, NOW)
    expect(two.map(p => p.id)).toEqual(['x', 'x-2'])
    expect(upsert(two, { ...c, id: 'x', name: 'Renamed' }, NOW).map(p => p.name)).toEqual(['Renamed', 'X'])
    expect(isToggle('/context-bar shows or hides it')).toBe(true)
    expect(isToggle('Open the heatmap')).toBe(false)
    expect([countdown(42_000), countdown(245_000), countdown(3_000_000)]).toEqual(['0:42', '4:05', '50 min'])
  })
})

describe('presets, in the mod', () => {
  test('save current setup from the pane, after running commands, then apply it', async ($, on) => {
    const { ran, store, toasts } = engine(on)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\repo' } as any)
    await $.command.run({ command: 'snake', args: '', origin: { kind: 'composer' } } as any)
    await $.command.run({ command: 'heatmap', args: '', origin: { kind: 'composer' } } as any)
    await $.command.run({ command: 'mod-manager', args: '' } as any)
    const pane = await $.ui.mount(PANE as any)
    await pane.press({ key: 'tab-presets' })
    await pane.input({ key: 'new-name', text: 'My setup' })
    const saved = (store.presets as any[])[0]
    expect(saved.name).toBe('My setup')
    expect(saved.mods).toEqual({ 'snake@claude-code-mods': 'on', 'heatmap@claude-code-mods': 'off' })
    expect(saved.steps).toEqual([{ command: 'heatmap', args: '', enabled: true }, { command: 'snake', args: '', enabled: false }]) // newest first; snake is a toggle
    expect(toasts.some(t => t.startsWith('Saved preset "My setup"'))).toBe(true)

    ran.length = 0
    await pane.press({ key: `apply-${saved.id}` })
    expect(ran.map(r => r.command)).toEqual(['heatmap']) // nothing to flip, so no reload; the toggle stays unticked
    await pane.unmount()
  })

  test('a preset that flips a mod reloads first and runs its commands after the reload', async ($, on) => {
    const { ran, runs, store, clock } = engine(on)
    store.presets = [{ id: 'all-on', name: 'All on', note: '', mods: { 'heatmap@claude-code-mods': 'on' }, steps: [{ command: 'heatmap', args: '', enabled: true }], pins: null, by: 'you', updatedAt: NOW }]
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\repo' } as any)
    await $.command.run({ command: 'mod-manager', args: '' } as any)
    const pane = await $.ui.mount(PANE as any)
    await pane.press({ key: 'tab-presets' })
    await pane.press({ key: 'apply-all-on' })
    expect(runs).toContainEqual(['C:\\claude.exe', 'plugin', 'enable', 'heatmap@claude-code-mods'])
    expect(ran.map(r => r.command)).toEqual(['reload-plugins'])
    expect(store.pendingApply).toBeDefined()
    await pane.unmount()
    // The reload: session.start again, and the owed commands run once the other mods registered theirs.
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\repo' } as any)
    await clock.advance(1_600)
    expect(ran.map(r => r.command)).toEqual(['reload-plugins', 'heatmap'])
    expect(store.pendingApply).toBeUndefined()
  })

  test("Claude's mod_presets tool lists, saves (marked by Claude) and refuses mods that are not installed", async ($, on) => {
    const { store } = engine(on)
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\repo' } as any)
    const list: any = await $.tool.call({ tool: 'mcp__mod-hub__mod_presets', action: 'list' } as any)
    expect(said(list)).toMatch(/snake@claude-code-mods \(on\): \/snake \[toggle\]/)
    const saved: any = await $.tool.call({ tool: 'mcp__mod-hub__mod_presets', action: 'save', preset: { name: 'Streaming', mods: { 'snake@claude-code-mods': 'off' }, steps: [{ command: 'heatmap' }] } } as any)
    expect(said(saved)).toMatch(/Saved preset "Streaming" \(id streaming\)/)
    expect((store.presets as any[])[0].by).toBe('claude')
    const bad: any = await $.tool.call({ tool: 'mcp__mod-hub__mod_presets', action: 'save', preset: { name: 'Nope', mods: { 'ghost@x': 'on' } } } as any)
    expect(bad.isError || bad.deny).toBeTruthy()
    expect((store.presets as any[]).length).toBe(1)
  })

  test('the bar counts the cache down after a request and says when it goes cold', async ($, on) => {
    const { clock } = engine(on)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\repo' } as any)
    let bar = await $.ui.mount(BAR as any)
    expect(await bar.find({ type: 'Text', text: '◷ cache · no request yet' })).toBeDefined()
    await bar.unmount()
    for await (const _ of ($ as any).turn.step({ turnId: 't', index: 0, model: 'claude-test', messages: [] })) void _
    await clock.advance(60_000)
    bar = await $.ui.mount(BAR as any)
    expect(await bar.find({ type: 'Text', text: '◷ cache warm · 4:00 left' })).toBeDefined()
    await bar.unmount()
    await clock.advance(5 * 60_000)
    bar = await $.ui.mount(BAR as any)
    expect(await bar.find({ type: 'Text', text: /◷ cache cold/ })).toBeDefined()
    await bar.unmount()
  })
})
