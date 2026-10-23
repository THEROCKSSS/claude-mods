import { describe, expect, mock, test } from 'claude-code/testing'

import { isNewer, parseLog, readCatalog, readInstalled, readMarkets } from '../hooks/updates'

const INSTALLED = {
  version: 2,
  plugins: {
    'snake@cc-mods': [{ version: '0.2.3', gitCommitSha: 'aaa111' }],
    'heatmap@cc-mods': [{ version: '0.1.1', gitCommitSha: 'aaa111' }],
    'mod-hub@owen-mods': [{ version: '0.1.0' }],
  },
}
const MARKETS = {
  'cc-mods': { source: { source: 'github', repo: 'x/cc-mods' }, installLocation: 'C:\\m\\cc-mods' },
  'owen-mods': { source: { source: 'directory', path: 'C:\\repo' }, installLocation: 'C:\\repo' },
}
const CATALOG = { plugins: [{ name: 'snake', source: './mods/snake', version: '0.2.4' }, { name: 'heatmap', source: './mods/heatmap' }] }

describe('the comparison', () => {
  test('reads installs, marketplaces and catalogs; compares versions', () => {
    expect(readInstalled(INSTALLED).map(p => [p.id, p.version, p.sha])).toEqual([['snake@cc-mods', '0.2.3', 'aaa111'], ['heatmap@cc-mods', '0.1.1', 'aaa111'], ['mod-hub@owen-mods', '0.1.0', '']])
    const m = readMarkets(MARKETS, d => d === 'C:/m/cc-mods')
    expect(m.get('cc-mods')).toEqual({ kind: 'git', dir: 'C:/m/cc-mods' })
    expect(m.get('owen-mods')).toEqual({ kind: 'folder', dir: 'C:/repo' })
    expect(readCatalog(CATALOG).get('snake')).toEqual({ path: 'mods/snake', version: '0.2.4' })
    expect(parseLog('abc1234\tFix the band\nnope\ndef5678\tAdd sound\n')).toEqual([{ sha: 'abc1234', subject: 'Fix the band' }, { sha: 'def5678', subject: 'Add sound' }])
    expect([isNewer('0.2.4', '0.2.3'), isNewer('0.2.10', '0.2.9'), isNewer('0.2.3', '0.2.3'), isNewer('0.1.3-win.2', '0.1.3-win.1'), isNewer('0.1.0', '0.2.0')]).toEqual([true, true, false, true, false])
  })
})

// The engine beneath: a git marketplace with a new snake, a folder marketplace whose mod-hub is ahead.
function engine(on: any) {
  const runs: string[][] = []
  const toasts: string[] = []
  const fwd = (p: string) => p.replace(/\\/g, '/')
  const clock = mock.clock(on)
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('command.run', () => ({ text: 'ok' }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : e.name === 'CLAUDE_CODE_EXECPATH' ? 'C:\\claude.exe' : undefined }))
  on('fs.read', (_$: any, e: any) => {
    const p = fwd(e.path)
    if (p.endsWith('/plugins/installed_plugins.json')) return { value: JSON.stringify(INSTALLED) }
    if (p.endsWith('/plugins/known_marketplaces.json')) return { value: JSON.stringify(MARKETS) }
    if (p === 'C:/repo/.claude-plugin/marketplace.json') return { value: JSON.stringify({ plugins: [{ name: 'mod-hub', source: './mods/mod-hub' }] }) }
    if (p === 'C:/repo/mods/mod-hub/.claude-plugin/plugin.json') return { value: JSON.stringify({ version: '0.2.0' }) }
    throw new Error('ENOENT')
  })
  on('fs.exists', (_$: any, e: any) => ({ value: fwd(e.path) === 'C:/m/cc-mods/.git' }))
  on('process.run', (_$: any, e: any) => {
    const a: string[] = e.argv
    runs.push(a)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (a[0] === 'git' && a[3] === 'fetch') return ok('')
    if (a[0] === 'git' && a[3] === 'rev-parse' && a[4] === '--abbrev-ref') return ok('origin/main\n')
    if (a[0] === 'git' && a[3] === 'show' && a[4] === 'origin/main:.claude-plugin/marketplace.json') return ok(JSON.stringify(CATALOG))
    if (a[0] === 'git' && a[3] === 'show') return ok(JSON.stringify({ version: '0.1.1' }))
    if (a[0] === 'git' && a[3] === 'log') return ok(a.at(-1) === 'mods/snake' ? 'f00d123\tSnake: wrap at the walls\n' : '')
    return ok('updated')
  })
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'below' }))
  return { runs, toasts, clock }
}
const PANE = { plugin: 'mod-updates', surface: 'desktop', component: 'Pane', requestId: 'mod-updates', props: { title: 'Mod Updates', isFocused: true, bodyColumns: 90, placement: 'dock' } }
const BAR = { plugin: 'mod-updates', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 120 } }

describe('mod-updates', () => {
  test('finds a git update with its commits and a folder version ahead, then updates one', async ($, on) => {
    const { runs, toasts, clock } = engine(on)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\repo' } as any)
    await clock.advance(20_500) // the first check, after the session settles
    expect(runs.some(a => a[0] === 'git' && a.includes('fetch'))).toBe(true)
    expect(toasts.some(t => /^2 mod updates: mod-hub, snake/.test(t))).toBe(true)
    const pane = await $.ui.mount(PANE as any)
    expect(await pane.find({ type: 'Text', text: 'Snake: wrap at the walls' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: ' v0.2.4 ' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: ' v0.2.0 ' })).toBeDefined() // mod-hub, from its folder
    await pane.press({ key: 'update-snake@cc-mods' })
    expect(runs).toContainEqual(['C:\\claude.exe', 'plugin', 'update', 'snake@cc-mods'])
    await pane.unmount()
    const bar = await $.ui.mount(BAR as any)
    expect(await bar.find({ type: 'Text', text: '⬆ 1 mod update' })).toBeDefined()
    expect(await bar.find({ type: 'Button', key: 'reload' })).toBeDefined()
    await bar.unmount()
  })
})
