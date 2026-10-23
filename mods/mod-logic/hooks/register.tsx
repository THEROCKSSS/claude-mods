// Mod Logic: how each mod works, read off its source and drawn as a graph.
//   - Every installed mod's hooks module (and the local files it imports) is read: the events
//     it hooks, the $ capabilities it calls (tagged by risk), what it registers.
//   - Live: when Claude edits a file inside a mod's folder, that mod is read again and the
//     graph moves within a second. A new folder with a .claude-plugin/ joins as a draft.
//   - /mod-logic: a pane with the 2D map (an Svg) and a breakdown per mod.
//   - The graph goes to the Mod Hub too (when it runs), whose #/logic view draws 2D and 3D.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LogicChange } from '../types'
import { analyze, buildGraph, filterKinds, focusGraph, graphSvg, importsOf, RISKS, sharedOnly, type ModLogic, type NodeKind } from '../shared/logic'

const PANE = 'mod-logic'
const PER_PAGE = 4
const DEBOUNCE_MS = 600
const MAX_FILES = 40 // per mod: a hooks module and the helpers it imports
const KINDS: { value: NodeKind; label: string }[] = [
  { value: 'event', label: 'Events' },
  { value: 'capability', label: 'Capabilities' },
  { value: 'command', label: 'Commands' },
  { value: 'tool', label: 'Tools' },
  { value: 'state', label: 'State' },
]

const logic = atom({ plugin: 'mod-logic', key: 'logic' } as const, [] as ModLogic[])
const changed = atom({ plugin: 'mod-logic', key: 'changed' } as const, null as LogicChange | null)
const tab = atom({ plugin: 'mod-logic', key: 'tab' } as const, 'map' as 'map' | 'breakdown')
const focus = atom({ plugin: 'mod-logic', key: 'focus' } as const, '')
const kinds = atom({ plugin: 'mod-logic', key: 'kinds' } as const, ['event', 'capability', 'command'] as NodeKind[])
const page = atom({ plugin: 'mod-logic', key: 'page' } as const, 0)
const shared = atom({ plugin: 'mod-logic', key: 'shared' } as const, true)

type Root = { id: string; name: string; dir: string; enabled: boolean }

let roots: Root[] = []
let drafts: Root[] = [] // folders with a .claude-plugin/ that Claude wrote this session, not installed
const timers = new Map<string, { cancel: () => void }>()

export const register: Register = on => {
  roots = []
  drafts = []

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'mod-logic', description: 'See how every mod works: what it hooks, calls and registers, as a live graph' }).catch(() => {})
    void readAll($).catch(() => {})
    return r
  })

  on('command.run', { command: 'mod-logic' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg) await update($, focus, () => ((roots.concat(drafts).find(x => x.name === arg)?.id) ?? ''))
    await readAll($).catch(() => {})
    await $.ui.open({ id: PANE, title: 'Mod Logic', focus: true })
    const list = await read($, logic)
    return { text: `Mod Logic: ${list.length} mods, ${list.reduce((n, m) => n + m.hooks.length, 0)} hooks.` }
  })

  // Live: a file Claude edits inside a mod's folder reads that mod again.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.tool !== 'Edit' && e.tool !== 'Write' && e.tool !== 'MultiEdit') return r
    const path = String((e as unknown as { file_path?: unknown }).file_path ?? '').replace(/\\/g, '/')
    if (path && !r.deny && !r.isError) void touched($, path).catch(() => {})
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))
}

// ── Finding mods and reading them ─────────────────────────────────────────

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

// a/b/../c → a/c, keeping a drive letter or a leading slash.
function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }
  return (path.startsWith('/') ? '/' : '') + parts.join('/')
}

async function configDir($: EngineInterface): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  if (config) return slash(config)
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined)) ?? ''
  return `${slash(home)}/.claude`
}

async function readJson($: EngineInterface, path: string): Promise<any> {
  const text = await $.fs.read(path).catch(() => '')
  try {
    return JSON.parse(typeof text === 'string' ? text : '')
  } catch {
    return undefined
  }
}

// Each installed plugin's folder: a folder marketplace's own source folder (so edits there are
// the ones that count), else the copy the install made.
async function findRoots($: EngineInterface): Promise<Root[]> {
  const dir = await configDir($)
  const installed = ((await readJson($, `${dir}/plugins/installed_plugins.json`))?.plugins ?? {}) as Record<string, { installPath?: string }[]>
  const markets = ((await readJson($, `${dir}/plugins/known_marketplaces.json`)) ?? {}) as Record<string, { source?: { source?: string; path?: string } }>
  const enabled = ((await $.settings.read({ key: 'enabledPlugins' }).catch(() => ({}))) ?? {}) as Record<string, unknown>
  const sourceDirs = new Map<string, Map<string, string>>() // marketplace → plugin name → folder
  for (const [name, m] of Object.entries(markets)) {
    if (m.source?.source !== 'directory' || !m.source.path) continue
    const base = slash(m.source.path)
    const manifest = await readJson($, `${base}/.claude-plugin/marketplace.json`)
    const map = new Map<string, string>()
    for (const p of (manifest?.plugins ?? []) as { name?: string; source?: unknown }[]) {
      if (typeof p.name === 'string' && typeof p.source === 'string' && p.source.startsWith('.')) map.set(p.name, normalize(`${base}/${p.source}`))
    }
    sourceDirs.set(name, map)
  }
  const out: Root[] = []
  for (const [id, rows] of Object.entries(installed)) {
    const at = id.lastIndexOf('@')
    const name = at > 0 ? id.slice(0, at) : id
    const market = at > 0 ? id.slice(at + 1) : ''
    const dirOf = sourceDirs.get(market)?.get(name) ?? (rows?.[0]?.installPath ? slash(rows[0].installPath) : '')
    if (dirOf) out.push({ id, name, dir: dirOf, enabled: enabled[id] !== false })
  }
  return out
}

async function readAll($: EngineInterface) {
  roots = await findRoots($)
  const list: ModLogic[] = []
  for (const root of [...roots, ...drafts]) list.push(await readMod($, root))
  await update($, logic, () => list.sort((a, b) => a.name.localeCompare(b.name)))
  void push($).catch(() => {})
}

// One mod's modules: those hooks.json names, and the local files they import, within its folder.
async function readMod($: EngineInterface, root: Root): Promise<ModLogic> {
  const hooksJson = await readJson($, `${root.dir}/hooks/hooks.json`)
  const modules = Array.isArray(hooksJson?.modules) ? (hooksJson.modules as unknown[]).filter((m): m is string => typeof m === 'string') : []
  if (modules.length === 0) {
    const empty = analyze(root.id, root.name, root.enabled, {})
    return { ...empty, error: hooksJson ? undefined : 'no hooks module: a classic plugin (skills, agents, commands)' }
  }
  const files: Record<string, string> = {}
  const queue = modules.map(m => normalize(`${root.dir}/hooks/${m}`))
  while (queue.length > 0 && Object.keys(files).length < MAX_FILES) {
    const path = queue.shift()!
    const rel = path.slice(root.dir.length + 1)
    if (rel in files || !path.startsWith(`${root.dir}/`)) continue
    const text = await readSource($, path)
    if (text === null) continue
    files[rel] = text
    const here = path.slice(0, path.lastIndexOf('/'))
    for (const spec of importsOf(text)) queue.push(normalize(`${here}/${spec}`))
  }
  return analyze(root.id, root.name, root.enabled, files)
}

// A module's text, trying the extensions an import may leave out.
async function readSource($: EngineInterface, path: string): Promise<string | null> {
  for (const candidate of /\.(tsx?|jsx?|mjs|cjs)$/.test(path) ? [path] : ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'].map(x => path + x)) {
    const text = await $.fs.read(candidate).catch(() => null)
    if (typeof text === 'string') return text
  }
  return null
}

// A file Claude just changed: the mod whose folder holds it is read again, soon (edits come in runs).
async function touched($: EngineInterface, path: string) {
  let root = [...roots, ...drafts].sort((a, b) => b.dir.length - a.dir.length).find(r => path.startsWith(`${r.dir}/`))
  if (!root) root = (await draftFor($, path)) ?? undefined
  if (!root) return
  const r = root
  timers.get(r.id)?.cancel()
  timers.set(
    r.id,
    $.clock.after(DEBOUNCE_MS, () => {
      void (async () => {
        const fresh = await readMod($, r)
        await update($, logic, list => [...list.filter(m => m.id !== r.id), fresh].sort((a, b) => a.name.localeCompare(b.name)))
        await update($, changed, () => ({ mod: r.id, file: path.slice(r.dir.length + 1), at: Date.now() }))
        await push($)
      })().catch(() => {})
    }),
  )
}

// A folder up to four levels above `path` that holds .claude-plugin/plugin.json: a mod being written.
async function draftFor($: EngineInterface, path: string): Promise<Root | null> {
  let dir = path.slice(0, path.lastIndexOf('/'))
  for (let i = 0; i < 4 && dir.includes('/'); i++) {
    const manifest = await readJson($, `${dir}/.claude-plugin/plugin.json`)
    if (manifest && typeof manifest.name === 'string') {
      const draft: Root = { id: `draft:${manifest.name}`, name: `${manifest.name} (draft)`, dir, enabled: false }
      drafts = [...drafts.filter(d => d.dir !== dir), draft]
      return draft
    }
    dir = dir.slice(0, dir.lastIndexOf('/'))
  }
  return null
}

// ── The hub ───────────────────────────────────────────────────────────────

type Server = { port: number; token: string }

async function hub($: EngineInterface): Promise<Server | null> {
  const s = await readJson($, `${await configDir($)}/mod-hub/server.json`)
  return s && typeof s.port === 'number' && typeof s.token === 'string' ? s : null
}

// Sends the logic to a running Mod Hub, for its 2D and 3D view; nothing happens when none runs.
async function push($: EngineInterface) {
  const s = await hub($)
  if (!s) return
  await $.http.fetch(`http://127.0.0.1:${s.port}/api/graph`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mod-hub-token': s.token },
    body: JSON.stringify({ mods: await read($, logic), changed: await read($, changed) }),
  }).catch(() => null)
}

async function openIn3D($: EngineInterface) {
  const s = await hub($)
  const ping = s ? await $.http.fetch(`http://127.0.0.1:${s.port}/api/ping`).catch(() => null) : null
  if (!s || ping?.status !== 200) {
    $.ui.toast('Starting the Mod Hub. Press 3D again once it opens')
    await $.command.run({ command: 'hub' }).catch(() => $.ui.toast('The 3D view needs mod-hub: install it, then run /hub'))
    return
  }
  await push($)
  const url = `http://127.0.0.1:${s.port}/#/logic`
  const isWindows = /^[A-Za-z]:\//.test(slash($.plugin.root))
  await $.process.run(isWindows ? ['explorer.exe', url] : ['open', url], { timeoutMs: 10_000 }).catch(() => null)
}

// ── The pane ──────────────────────────────────────────────────────────────

export function ago(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`
}

async function drawPane($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const Select = 'Select' in elements ? elements.Select : undefined
  const Svg = 'Svg' in elements ? elements.Svg : undefined
  const list = await read($, logic)
  const last = await read($, changed)
  const view = await read($, tab)
  const picked = await read($, focus)
  const shownKinds = await read($, kinds)
  const at = await read($, page)
  const isShared = await read($, shared)
  const now = Date.now()

  if (list.length === 0) return <Text dimColor>Reading your mods…</Text>
  const readable = list.filter(m => !m.error)
  const full = buildGraph(readable)
  // One mod: everything it touches. Every mod: only where two or more meet, unless asked for all.
  const kindsShown = filterKinds(picked ? focusGraph(full, picked) : full, shownKinds)
  const graph = picked || !isShared ? kindsShown : sharedOnly(kindsShown)
  const hookCount = readable.reduce((n, m) => n + m.hooks.length, 0)
  const capCount = full.nodes.filter(n => n.kind === 'capability').length

  const toggleKind = (k: NodeKind) => update($, kinds, ks => (ks.includes(k) ? ks.filter(x => x !== k) : [...ks, k]))

  const head = (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
        <Text bold>{`${readable.length} mods · ${hookCount} hooks · ${capCount} capabilities`}</Text>
        <Button key="tab-map" label="◇ Map" variant={view === 'map' ? 'primary' : undefined} onPress={() => update($, tab, () => 'map')} />
        <Button key="tab-breakdown" label="☰ Breakdown" variant={view === 'breakdown' ? 'primary' : undefined} onPress={() => update($, tab, () => 'breakdown')} />
        <Button key="three-d" label="◈ 2D/3D in Hub" onPress={() => openIn3D($)} />
        <Button key="refresh" label="↻" plain dimColor onPress={() => readAll($)} />
        <Button key="close" label="Close" plain dimColor role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
      <Text dimColor wrap="truncate-end">
        {last ? `✎ live: ${last.mod.replace(/@.*$/, '')} changed ${ago(last.at, now)} (${last.file})` : '✎ live: edit any mod and its logic redraws here'}
      </Text>
    </Box>
  )

  const controls = (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
      {Select && (
        <Select
          key="focus"
          label="Mod"
          options={[{ value: '', label: 'Every mod' }, ...readable.map(m => ({ value: m.id, label: m.name }))]}
          value={picked}
          onSelect={v => {
            void update($, focus, () => v)
            void update($, page, () => 0)
          }}
        />
      )}
      {view === 'map' && !picked && (
        <Button key="shared" label={isShared ? '◎ Shared only' : '◉ Everything'} variant={isShared ? 'primary' : undefined} onPress={() => update($, shared, s => !s)} />
      )}
      {view === 'map' &&
        KINDS.map(k => (
          <Button key={`kind-${k.value}`} label={`${shownKinds.includes(k.value) ? '☑' : '☐'} ${k.label}`} plain dimColor={!shownKinds.includes(k.value)} onPress={() => toggleKind(k.value)} />
        ))}
    </Box>
  )

  if (view === 'map') {
    return (
      <Box flexDirection="column" gap={1}>
        {head}
        {controls}
        {Svg ? (
          <Svg key="map" source={graphSvg(graph, { width: 900, height: 560, focus: picked || undefined, changed: last && now - last.at < 30_000 ? last.mod : undefined })} alt={`Graph of ${graph.nodes.length} parts across ${readable.length} mods`} isInteractive />
        ) : (
          <Text dimColor>This surface draws no pictures. ☰ Breakdown has the same in words, and ◈ opens the 3D view.</Text>
        )}
        <Text dimColor wrap="wrap">
          {'● mods  ◯ events  ■ capabilities by risk: '}
          {RISKS.filter(r => r.value !== 'other').map(r => r.label).join(' · ')}
          {'  ·  hover a shape for who uses it'}
        </Text>
      </Box>
    )
  }

  const mods = picked ? readable.filter(m => m.id === picked) : list
  const pages = Math.max(1, Math.ceil(mods.length / PER_PAGE))
  const p = Math.min(at, pages - 1)
  return (
    <Box flexDirection="column" gap={1}>
      {head}
      {controls}
      {mods.slice(p * PER_PAGE, (p + 1) * PER_PAGE).map(m => (
        <Box key={`logic-${m.id}`} flexDirection="column" borderStyle="round" borderColor={last?.mod === m.id && now - last.at < 30_000 ? 'yellow' : undefined} borderDimColor={last?.mod !== m.id} paddingX={1}>
          <Text>
            <Text bold>{m.name}</Text>
            <Text dimColor>{m.error ? `  ${m.error}` : `  ${m.lines} lines in ${m.files.length} file${m.files.length === 1 ? '' : 's'}${m.enabled ? '' : ' · off'}`}</Text>
          </Text>
          {!m.error && (
            <>
              <Text wrap="wrap">
                <Text color="#7fb8a4">{'hooks  '}</Text>
                <Text dimColor>{m.hooks.length ? m.hooks.map(h => `${h.event}${h.matcher ? ` · ${h.matcher}` : ''}${h.count > 1 ? ` ×${h.count}` : ''}`).join(',  ') : 'none'}</Text>
              </Text>
              <Text wrap="wrap">
                <Text color="#9aa7c7">{'calls  '}</Text>
                {m.calls.length === 0 && <Text dimColor>none</Text>}
                {m.calls.map((c, i) => (
                  <Text key={`call-${c.name}`} color={RISKS.find(r => r.value === c.risk)?.color}>
                    {`${i ? ',  ' : ''}$.${c.name}${c.count > 1 ? ` ×${c.count}` : ''}`}
                  </Text>
                ))}
              </Text>
              {(m.commands.length > 0 || m.tools.length > 0 || m.state.length > 0) && (
                <Text dimColor wrap="wrap">
                  {[m.commands.length ? `commands ${m.commands.map(c => `/${c}`).join(' ')}` : '', m.tools.length ? `tools ${m.tools.join(' ')}` : '', m.state.length ? `state ${m.state.join(' ')}` : ''].filter(Boolean).join('   ·   ')}
                </Text>
              )}
              {m.hooks.some(h => h.event === 'tool.call' || h.event === 'tool.check') && m.guards === 0 && !m.calls.every(c => c.risk === 'draws' || c.risk === 'state') && (
                <Text color="yellow" wrap="wrap">
                  ⚠ hooks tool calls with no .catch handler: if it throws, the call goes ahead unchecked
                </Text>
              )}
            </>
          )}
        </Box>
      ))}
      {pages > 1 && (
        <Box flexDirection="row" justifyContent="space-between">
          <Button key="prev" label="‹ Prev" plain dimColor={p === 0} onPress={() => update($, page, n => Math.max(0, n - 1))} />
          <Text dimColor>{`${p + 1} of ${pages}`}</Text>
          <Button key="next" label="Next ›" plain dimColor={p >= pages - 1} onPress={() => update($, page, n => Math.min(pages - 1, n + 1))} />
        </Box>
      )}
    </Box>
  )
}
