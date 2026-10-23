import { describe, expect, mock, test } from 'claude-code/testing'

import { analyze, buildGraph, focusGraph, graphSvg, importsOf, layout, riskOf, sharedOnly } from '../shared/logic'

const GUARD = `
import { helper } from './helper'
// a comment that says $.http.fetch( is not a call
const held = atom({ plugin: 'g', key: 'held' } as const, null)
export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, ($, e, next) => check($, e, next)).catch(failClosed)
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'guard', description: 'x' })
    return next(e)
  })
}
async function check($, e, next) {
  await $.process.run(['git', 'status'])
  await $.process.run(['git', 'log'])
  await $.ui.toast('hi')
  return next(e)
}
`
const BAND = `
export const register: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => next(e))
  on('session.start', async ($, e, next) => { await $.http.fetch('https://x'); return next(e) })
}
`

describe('the analyzer', () => {
  test('reads hooks with matchers, calls by risk, registrations, guards; ignores comments', () => {
    const m = analyze('g@m', 'g', true, { 'hooks/register.tsx': GUARD, 'hooks/helper.ts': 'export const helper = 1' })
    expect(m.hooks).toEqual([
      { event: 'session.start', matcher: '', count: 1 },
      { event: 'tool.call', matcher: 'Bash', count: 1 },
    ])
    expect(m.calls).toEqual([
      { name: 'process.run', risk: 'runs', count: 2 },
      { name: 'command.register', risk: 'other', count: 1 },
      { name: 'ui.toast', risk: 'draws', count: 1 },
    ])
    expect(m.calls.some(c => c.name === 'http.fetch')).toBe(false) // it was only in a comment
    expect(m.commands).toEqual(['guard'])
    expect(m.state).toEqual(['held'])
    expect(m.guards).toBe(1)
    expect(m.files).toEqual(['hooks/helper.ts', 'hooks/register.tsx'])
    expect(importsOf(GUARD)).toEqual(['./helper'])
  })

  test('risk per capability', () => {
    expect([riskOf('process.run'), riskOf('http.fetch'), riskOf('fs.write'), riskOf('fs.read'), riskOf('command.run'), riskOf('ui.open'), riskOf('store.set'), riskOf('clock.every')]).toEqual([
      'runs', 'network', 'writes', 'reads', 'drives', 'draws', 'state', 'time',
    ])
  })

  test('the graph joins mods where they share an event or a capability', () => {
    const g = buildGraph([analyze('g@m', 'g', true, { 'r.tsx': GUARD }), analyze('b@m', 'b', true, { 'r.tsx': BAND })])
    const start = g.nodes.find(n => n.id === 'event:session.start')
    expect(start?.mods.sort()).toEqual(['b@m', 'g@m']) // one node, both mods
    expect(sharedOnly(g).nodes.map(n => n.id).sort()).toEqual(['event:session.start', 'mod:b@m', 'mod:g@m'])
    const focused = focusGraph(g, 'b@m')
    expect(focused.nodes.some(n => n.id === 'cap:process.run')).toBe(false) // only g calls it
    expect(focused.nodes.some(n => n.id === 'cap:http.fetch')).toBe(true)
    const pos = layout(g, 3)
    expect(Object.values(pos).every(p => p.every(v => Math.abs(v) <= 1.0001))).toBe(true)
    expect(graphSvg(g, { width: 600, height: 400 })).toMatch(/^<svg[\s\S]*<title>session\.start \(event\)\nused by 2 mods: b, g<\/title>/)
  })
})

// The engine beneath: one installed mod in a folder marketplace, its source on disk, an editable file.
function engine(on: any, files: Record<string, string>) {
  const fwd = (p: string) => p.replace(/\\/g, '/')
  const clock = mock.clock(on)
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('fs.read', (_$: any, e: any) => {
    const p = fwd(e.path)
    if (p.endsWith('/plugins/installed_plugins.json')) return { value: JSON.stringify({ plugins: { 'g@mine': [{ installPath: 'C:\\cache\\g' }] } }) }
    if (p.endsWith('/plugins/known_marketplaces.json')) return { value: JSON.stringify({ mine: { source: { source: 'directory', path: 'C:\\repo' } } }) }
    if (p === 'C:/repo/.claude-plugin/marketplace.json') return { value: JSON.stringify({ plugins: [{ name: 'g', source: './mods/g' }] }) }
    if (p in files) return { value: files[p] }
    throw new Error('ENOENT')
  })
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'below' }))
  return { clock, files }
}

describe('mod-logic', () => {
  test('reads a folder marketplace mod from its source, and an edit there redraws its logic', async ($, on) => {
    const files: Record<string, string> = {
      'C:/repo/mods/g/hooks/hooks.json': '{ "modules": ["./register.tsx"] }',
      'C:/repo/mods/g/hooks/register.tsx': BAND,
    }
    const { clock } = engine(on, files)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\repo' } as any)
    await clock.advance(10)
    await $.command.run({ command: 'mod-logic', args: '' } as any)
    const PANE = { plugin: 'mod-logic', surface: 'desktop', component: 'Pane', requestId: 'mod-logic', props: { title: 'Mod Logic', isFocused: true, bodyColumns: 100, placement: 'dock' } }
    let pane = await $.ui.mount(PANE as any)
    await pane.press({ key: 'tab-breakdown' })
    expect(await pane.find({ type: 'Text', text: /ui\.render · AbovePrompt/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /\$\.process\.run/ })).toBeUndefined()

    // Claude edits the mod: it now runs a program in a tool.call hook, with no .catch.
    files['C:/repo/mods/g/hooks/register.tsx'] = BAND + "\non('tool.call', async ($, e, next) => { await $.process.run(['ls']); return next(e) })\n"
    await $.tool.call({ tool: 'Edit', file_path: 'C:\\repo\\mods\\g\\hooks\\register.tsx', old_string: 'a', new_string: 'b' } as any)
    await clock.advance(700)
    await pane.unmount()
    pane = await $.ui.mount(PANE as any)
    expect(await pane.find({ type: 'Text', text: /\$\.process\.run/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /live: g changed .* \(hooks\/register\.tsx\)/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /no \.catch handler/ })).toBeDefined() // the fail-open warning
    await pane.press({ key: 'tab-map' })
    const map: any = await pane.find({ type: 'Svg' })
    expect(map.props.source).toContain('<svg')
    await pane.unmount()
  })
})
