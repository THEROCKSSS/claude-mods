// Mod Hub: every installed mod in one place, without typing commands in chat.
//   - A bar above the prompt: ⚙ Mods opens the manager pane, ◈ Hub the web app, then a
//     button for each pinned command, and ↻ Reload once a mod was turned on or off.
//   - /mod-manager: a pane listing each mod with On/Off, a button per command, and pins.
//   - /hub: starts the local web app (server/hub.mjs) and opens it in the browser.
//     The page only queues actions; this module checks each one against what is
//     installed and runs it: a command through $.command.run, On/Off through the
//     running Claude Code's `plugin enable|disable`, a reload through /reload-plugins.
import { atom, read, update } from 'claude-code'
import type { CommandInfo, EngineInterface, Register, Timer } from 'claude-code'

import type { HubState, ModRow } from '../types'
import { bandsFile, parseOrder, stackBands } from './bands'
import { cleanView, counts, DEFAULT_VIEW, FILTERS, isDefault, isNew, SORTS, sources, viewMods, type View } from '../shared/view'

const NAME = 'mod-hub'
const PANE = 'mod-hub'
const PER_PAGE = { cards: 6, compact: 12 }
const VIEW_KEY = 'view'
const TICK_MS = 1_500 // how often the hub is asked for actions while it runs
const REFRESH_MS = 15_000 // how often installed plugins are read again
const PINS_KEY = 'pins'
const DEFAULT_PINS = ['mod-logic', 'mission']

const state = atom({ plugin: 'mod-hub', key: 'state' } as const, null as HubState | null)
const hubUrl = atom({ plugin: 'mod-hub', key: 'hubUrl' } as const, '')
const note = atom({ plugin: 'mod-hub', key: 'note' } as const, '')
const view = atom({ plugin: 'mod-hub', key: 'view' } as const, DEFAULT_VIEW as View)
const compact = atom({ plugin: 'mod-hub', key: 'compact' } as const, false)
const clickMode = atom({ plugin: 'mod-hub', key: 'clickMode' } as const, 'run' as 'run' | 'copy')
const page = atom({ plugin: 'mod-hub', key: 'page' } as const, 0)
const busy = atom({ plugin: 'mod-hub', key: 'busy' } as const, '')

type Server = { port: number; host: string; token: string; pid: number }
type Action =
  | { seq: number; type: 'run'; command: string; args?: string }
  | { seq: number; type: 'toggle'; id: string; on: boolean }
  | { seq: number; type: 'reload' }
  | { seq: number; type: 'pins'; pins: string[] }

let port = 8796
let showBar = true
let timer: Timer | undefined
let ticks = 0
let lastSeq = 0
let lastPushed = ''
let isTurnRunning = false // a command run now waits for the turn to end; the person is told so
let pending: string[] = [] // module-level: a reload runs register again and empties it, which is right
let bandOrder: Promise<string[]> | undefined

export const register: Register = (on, options) => {
  port = typeof options.port === 'number' && options.port >= 1024 ? options.port : 8796
  showBar = options.showBar !== false
  pending = []
  lastPushed = ''
  bandOrder = undefined

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'mod-manager', description: 'Turn mods on and off, run their commands, and pin them to the bar' }).catch(() => {})
    await $.command.register({ name: 'hub', description: 'Open the Mod Hub web app: every mod, live, with a command palette' }).catch(() => {})
    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => {
      void tick($).catch(() => {})
    })
    await refresh($).catch(() => {})
    await restoreView($).catch(() => {})
    void connect($).catch(() => {}) // a hub left running from an earlier session picks up again
    return r
  })

  on('command.run', { command: 'mod-manager' }, async $ => {
    await refresh($).catch(() => {})
    await $.ui.open({ id: PANE, title: 'Mod Manager', focus: true })
    return { text: 'Mod Manager opened.' }
  })

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) isTurnRunning = false // a subagent's turn ending leaves the main one running
    return next(e)
  })

  on('command.run', { command: 'hub' }, async $ => {
    const url = await openHub($)
    return { text: url ? `Mod Hub: ${url}` : `Mod Hub did not start: ${await read($, note)}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!showBar || e.props.hasSurvey) return rest
    const s = await read($, state)
    const { Box, Button, Text } = $.ui.resolve(e)
    const runnable = new Set(allCommands(s).map(c => c.name))
    const pins = (s?.pins ?? []).filter(p => runnable.has(p))
    // Its own panel, bordered like context-bar's, so the buttons read as one control and not as loose text.
    const mine = (
      <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
          <Text color="#e3a857" bold>
            {'▣ mods'}
          </Text>
          <Text dimColor>│</Text>
          <Button key="mods" label="⚙ Manage" onPress={() => openPane($)} />
          <Button key="hub" label="◈ Hub" onPress={() => void openHub($)} />
          {pending.length > 0 && (
            <Button key="reload" label={`↻ Reload · ${pending.length} changed`} variant="primary" onPress={() => reload($)} />
          )}
          <Text dimColor>│</Text>
          {pins.length > 0 ? <Text dimColor>pinned</Text> : <Text dimColor>☆ pin commands in Manage to keep them here</Text>}
          {pins.map(p => (
            <Button key={`pin-${p}`} label={`/${p}`} plain onPress={() => pressCommand($, p)} />
          ))}
        </Box>
      </Box>
    )
    return stackBands(rest, NAME, mine, 'above', await (bandOrder ??= readBandOrder($).catch(() => [])))
  })
}

// ── Reading what is installed ─────────────────────────────────────────────

async function refresh($: EngineInterface) {
  const [commands, installed, enabled, version, stored] = await Promise.all([
    $.command.list().catch((): CommandInfo[] => []),
    readInstalled($),
    $.settings.read({ key: 'enabledPlugins' }).then(v => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {}), () => ({}) as Record<string, unknown>),
    $.session.version().then(v => v.version, () => undefined),
    $.store.get(PINS_KEY).catch(() => undefined),
  ])
  const pins = Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string') : DEFAULT_PINS
  await update($, state, () => build(commands, installed, enabled, pins, pending, version))
}

type Installed = { id: string; name: string; marketplace: string; version: string; installedAt: string; description: string }

// Every plugin in a commands list and a settings snapshot, as rows the bar, pane and hub draw.
export function build(
  commands: CommandInfo[],
  installed: Installed[],
  enabled: Record<string, unknown>,
  pins: string[],
  pendingIds: string[],
  claudeVersion?: string,
): HubState {
  const byPlugin = new Map<string, { name: string; description: string }[]>()
  const otherCommands: HubState['otherCommands'] = []
  for (const c of commands) {
    if (c.source === 'plugin') {
      const key = (c.plugin ?? '').replace(/@.*$/, '')
      byPlugin.set(key, [...(byPlugin.get(key) ?? []), { name: c.name, description: c.description }])
    } else {
      otherCommands.push({ name: c.name, description: c.description, source: c.source })
    }
  }
  const mods: ModRow[] = installed
    .map(p => ({
      ...p,
      enabled: enabled[p.id] !== false, // installed and not switched off
      commands: (byPlugin.get(p.name) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      isSelf: p.name === NAME,
    }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
  return { generatedAt: Date.now(), claudeVersion, mods, otherCommands, pins, pending: [...pendingIds] }
}

function allCommands(s: HubState | null) {
  return [...(s?.mods.flatMap(m => m.commands) ?? []), ...(s?.otherCommands ?? [])]
}

async function configDir($: EngineInterface): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  if (config) return config.replace(/\\/g, '/').replace(/\/+$/, '')
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined)) ?? ''
  return `${home.replace(/\\/g, '/').replace(/\/+$/, '')}/.claude`
}

async function readInstalled($: EngineInterface): Promise<Installed[]> {
  const text = await $.fs.read(`${await configDir($)}/plugins/installed_plugins.json`).catch(() => '')
  let plugins: Record<string, unknown> = {}
  try {
    plugins = (JSON.parse(typeof text === 'string' ? text : '') as { plugins?: Record<string, unknown> }).plugins ?? {}
  } catch {
    return []
  }
  const out: Installed[] = []
  for (const [id, rows] of Object.entries(plugins)) {
    const row = (Array.isArray(rows) ? rows[0] : undefined) as Record<string, unknown> | undefined
    if (!row) continue
    const at = id.lastIndexOf('@')
    const path = typeof row.installPath === 'string' ? row.installPath.replace(/\\/g, '/') : ''
    const manifest = path ? await $.fs.read(`${path}/.claude-plugin/plugin.json`).catch(() => '') : ''
    let description = ''
    try {
      const d = (JSON.parse(typeof manifest === 'string' ? manifest : '') as { description?: unknown }).description
      description = typeof d === 'string' ? d : ''
    } catch {}
    out.push({
      id,
      name: at > 0 ? id.slice(0, at) : id,
      marketplace: at > 0 ? id.slice(at + 1) : '',
      version: String(row.version ?? ''),
      installedAt: String(row.installedAt ?? ''),
      description,
    })
  }
  return out
}

async function readBandOrder($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined))?.replace(/\\/g, '/')
  const file = bandsFile(await $.env.get('CLAUDE_CONFIG_DIR'), home)
  return file && (await $.fs.exists(file)) ? parseOrder(await $.fs.read(file)) : []
}

// ── Doing things ──────────────────────────────────────────────────────────

async function openPane($: EngineInterface) {
  await refresh($).catch(() => {})
  await $.ui.open({ id: PANE, title: 'Mod Manager', focus: true })
}

// Runs a slash command the session lists, as if the person typed it.
async function runCommand($: EngineInterface, command: string, args = '') {
  const known = (await $.command.list().catch((): CommandInfo[] => [])).some(c => c.name === command)
  if (!known) {
    await update($, note, () => `/${command} is not a command this session has`)
    return
  }
  // The engine runs a command started mid-turn once the turn ends: say so, so the press is not a mystery.
  if (isTurnRunning) $.ui.toast(`/${command} is queued: it runs as soon as Claude finishes this turn`)
  await $.command.run({ command, args }).catch(async (err: unknown) => {
    await update($, note, () => `/${command} did not run: ${err instanceof Error ? err.message : String(err)}`)
  })
}

// Puts `/command` on the clipboard: the surface's own first, else the system's (clip, pbcopy, xclip).
async function copyCommand($: EngineInterface, command: string) {
  const text = `/${command}`
  const viaSurface = await $.ui.copy({ text }).catch(() => ({ isCopied: false }))
  let isCopied = viaSurface.isCopied
  if (!isCopied) {
    const isWindows = /^[A-Za-z]:\//.test($.plugin.root.replace(/\\/g, '/'))
    const tools = isWindows ? [['clip']] : [['pbcopy'], ['wl-copy'], ['xclip', '-selection', 'clipboard']]
    for (const argv of tools) {
      const r = await $.process.run(argv, { stdin: text, timeoutMs: 5_000 }).catch(() => null)
      if (r?.exitCode === 0) {
        isCopied = true
        break
      }
    }
  }
  $.ui.toast(isCopied ? `Copied ${text}: paste it into the prompt` : `Could not reach a clipboard. The command is ${text}`)
}

// What a press on a command does: run it, or copy it, as the Click switch says.
async function pressCommand($: EngineInterface, command: string) {
  if ((await read($, clickMode)) === 'copy') await copyCommand($, command)
  else await runCommand($, command)
}

// Turns an installed plugin on or off through the running Claude Code; takes effect on reload.
async function toggle($: EngineInterface, id: string, isOn: boolean) {
  const s = await read($, state)
  const mod = s?.mods.find(m => m.id === id)
  if (!mod || mod.isSelf) return
  await update($, busy, () => id)
  const exe = (await $.env.get('CLAUDE_CODE_EXECPATH').catch(() => undefined)) || 'claude'
  const r = await $.process.run([exe, 'plugin', isOn ? 'enable' : 'disable', id], { timeoutMs: 60_000 }).catch(() => null)
  await update($, busy, () => '')
  if (!r || r.exitCode !== 0) {
    await update($, note, () => `Could not turn ${mod.name} ${isOn ? 'on' : 'off'}: ${(r?.stderr || r?.stdout || 'claude did not run').trim().split('\n').slice(-1)[0]}`)
    return
  }
  pending = pending.includes(id) ? pending.filter(p => p !== id) : [...pending, id] // a second flip undoes the first
  await update($, note, () => '')
  await update($, state, prev => (prev ? { ...prev, pending: [...pending], mods: prev.mods.map(m => (m.id === id ? { ...m, enabled: isOn } : m)) } : prev))
  $.ui.toast(`${mod.name} turned ${isOn ? 'on' : 'off'}. Reload to apply`)
}

async function reload($: EngineInterface) {
  await $.command.run({ command: 'reload-plugins' }).catch(() => $.ui.toast('Run /reload-plugins to apply the changes'))
}

async function setPins($: EngineInterface, pins: string[]) {
  const clean = [...new Set(pins.filter(p => typeof p === 'string' && /^[\w:.-]{1,64}$/.test(p)))].slice(0, 12)
  await $.store.set(PINS_KEY, clean).catch(() => {})
  await update($, state, prev => (prev ? { ...prev, pins: clean } : prev))
}

async function togglePin($: EngineInterface, command: string) {
  const pins = (await read($, state))?.pins ?? []
  await setPins($, pins.includes(command) ? pins.filter(p => p !== command) : [...pins, command])
}

// ── The hub server ────────────────────────────────────────────────────────

async function serverInfo($: EngineInterface): Promise<Server | null> {
  const text = await $.fs.read(`${await configDir($)}/mod-hub/server.json`).catch(() => '')
  try {
    const s = JSON.parse(typeof text === 'string' ? text : '') as Server
    return typeof s.port === 'number' && typeof s.token === 'string' ? s : null
  } catch {
    return null
  }
}

async function ping($: EngineInterface, s: Server): Promise<boolean> {
  const r = await $.http.fetch(`http://127.0.0.1:${s.port}/api/ping`, { headers: { 'x-mod-hub-token': s.token } }).catch(() => null)
  return r?.status === 200 && /"ok":true/.test(r.text)
}

// Finds a running hub and remembers its address; '' when none answers.
async function connect($: EngineInterface): Promise<string> {
  const s = await serverInfo($)
  const url = s && (await ping($, s)) ? `http://127.0.0.1:${s.port}/` : ''
  await update($, hubUrl, () => url)
  return url
}

// Starts the hub when it is not running, waits for it to answer, and opens it in the browser.
async function openHub($: EngineInterface, hash = ''): Promise<string> {
  let url = await connect($)
  if (!url) {
    const started = await startServer($)
    if (!started) return ''
    for (let i = 0; i < 20 && !url; i++) {
      await $.clock.sleep(250)
      url = await connect($)
    }
    if (!url) {
      await update($, note, () => `the hub did not answer on port ${port}; is something else using it?`)
      return ''
    }
  }
  lastPushed = '' // a fresh page gets the whole state at once
  await push($).catch(() => {})
  await openUrl($, `${url}${hash}`)
  return url
}

async function startServer($: EngineInterface): Promise<boolean> {
  const root = $.plugin.root.replace(/\\/g, '/')
  const args = [`${root}/server/hub.mjs`, '--dir', `${await configDir($)}/mod-hub`, '--app', `${root}/app`, '--port', String(port)]
  const isWindows = /^[A-Za-z]:\//.test(root)
  // Detached, so the hub outlives this call: Start-Process on Windows, nohup elsewhere.
  const argv = isWindows
    ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', `Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList @(${args.map(psArg).join(',')})`]
    : ['sh', '-c', 'nohup node "$@" >/dev/null 2>&1 &', 'mod-hub', ...args]
  const r = await $.process.run(argv, { timeoutMs: 15_000 }).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  if (r.exitCode !== 0) {
    await update($, note, () => `could not start the hub (is Node.js installed?): ${r.stderr.trim().split('\n').slice(-1)[0]}`)
    return false
  }
  return true
}

// One Start-Process argument: double quotes inside, so a path with spaces stays one argument, in a single-quoted literal.
function psArg(a: string) {
  return `'"${a.replace(/'/g, "''")}"'`
}

async function openUrl($: EngineInterface, url: string) {
  const isWindows = /^[A-Za-z]:\//.test($.plugin.root.replace(/\\/g, '/'))
  const uname = isWindows ? null : await $.process.run(['uname', '-s'], { timeoutMs: 3_000 }).catch(() => null)
  const argv = isWindows ? ['explorer.exe', url] : [uname?.stdout.trim() === 'Darwin' ? 'open' : 'xdg-open', url]
  await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => null)
}

// Sends the state when it changed (and every ~10 s, so the page knows the session is alive).
async function push($: EngineInterface) {
  const s = await read($, state)
  const server = await serverInfo($)
  if (!s || !server) return
  const body = JSON.stringify(s)
  const sameAsLast = body.replace(/"generatedAt":\d+/, '') === lastPushed
  if (sameAsLast && ticks % 7 !== 0) return
  const r = await $.http.fetch(`http://127.0.0.1:${server.port}/api/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mod-hub-token': server.token },
    body,
  }).catch(() => null)
  if (r?.ok) lastPushed = body.replace(/"generatedAt":\d+/, '')
  else await update($, hubUrl, () => '')
}

// One beat: read plugins now and then; while the hub runs, send the state and run what it queued.
async function tick($: EngineInterface) {
  ticks++
  if (ticks % Math.round(REFRESH_MS / TICK_MS) === 0) await refresh($).catch(() => {})
  if (!(await read($, hubUrl))) {
    if (ticks % 10 === 0) await connect($) // a hub started elsewhere joins within 15 s
    return
  }
  await push($)
  const server = await serverInfo($)
  if (!server) return
  const r = await $.http.fetch(`http://127.0.0.1:${server.port}/api/actions?after=${lastSeq}`, { headers: { 'x-mod-hub-token': server.token } }).catch(() => null)
  if (!r?.ok) return
  let actions: Action[] = []
  try {
    actions = (JSON.parse(r.text) as { actions?: Action[] }).actions ?? []
  } catch {
    return
  }
  for (const a of actions) {
    if (typeof a.seq !== 'number' || a.seq <= lastSeq) continue
    lastSeq = a.seq
    await perform($, a)
  }
}

// What the page asked for, checked against this session before it runs.
async function perform($: EngineInterface, a: Action) {
  if (a.type === 'run' && typeof a.command === 'string') await runCommand($, a.command, typeof a.args === 'string' ? a.args.slice(0, 500) : '')
  else if (a.type === 'toggle' && typeof a.id === 'string' && typeof a.on === 'boolean') await toggle($, a.id, a.on)
  else if (a.type === 'reload') await reload($)
  else if (a.type === 'pins' && Array.isArray(a.pins)) await setPins($, a.pins)
}

// ── The pane ──────────────────────────────────────────────────────────────

async function restoreView($: EngineInterface) {
  const saved = (await $.store.get(VIEW_KEY).catch(() => undefined)) as { view?: unknown; compact?: unknown } | undefined
  await update($, view, () => ({ ...cleanView(saved?.view), query: '' })) // the search starts empty each session
  await update($, compact, () => saved?.compact === true)
  await update($, clickMode, () => ((saved as { clickMode?: unknown } | undefined)?.clickMode === 'copy' ? 'copy' : 'run'))
}

async function setClickMode($: EngineInterface, mode: 'run' | 'copy') {
  await update($, clickMode, () => mode)
  await $.store.set(VIEW_KEY, { view: { ...(await read($, view)), query: '' }, compact: await read($, compact), clickMode: mode }).catch(() => {})
}

// Changes the view, starts it at its first page, and keeps it for next session.
async function setView($: EngineInterface, change: Partial<View>) {
  const next = await update($, view, v => ({ ...v, ...change }))
  await update($, page, () => 0)
  await $.store.set(VIEW_KEY, { view: { ...next, query: '' }, compact: await read($, compact), clickMode: await read($, clickMode) }).catch(() => {})
}

async function setCompact($: EngineInterface, isCompact: boolean) {
  await update($, compact, () => isCompact)
  await update($, page, () => 0)
  await $.store.set(VIEW_KEY, { view: { ...(await read($, view)), query: '' }, compact: isCompact, clickMode: await read($, clickMode) }).catch(() => {})
}

// "3 h ago", "2 days ago": how long since a mod was installed.
export function since(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const m = Math.max(0, Math.round((now - at) / 60_000))
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

async function drawPane($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const Input = 'Input' in elements ? elements.Input : undefined
  const Select = 'Select' in elements ? elements.Select : undefined
  const s = await read($, state)
  if (!s) return <Text dimColor>Reading your mods…</Text>
  const v = await read($, view)
  const isCompact = await read($, compact)
  const at = await read($, page)
  const problem = await read($, note)
  const working = await read($, busy)
  const url = await read($, hubUrl)
  const now = await $.clock.now()
  const mode = await read($, clickMode)

  const ctx = { pins: s.pins, pending: s.pending, now }
  // This mod always leads the list, wherever the sort would put it.
  const shown = viewMods(s.mods, v, ctx).sort((a, b) => Number(b.isSelf) - Number(a.isSelf))
  const tally = counts(s.mods, v, ctx)
  const per = isCompact ? PER_PAGE.compact : PER_PAGE.cards
  const pages = Math.max(1, Math.ceil(shown.length / per))
  const p = Math.min(at, pages - 1)
  const on = s.mods.filter(m => m.enabled).length
  const markets = sources(s.mods)

  const flip = (m: ModRow) =>
    m.isSelf ? (
      <Text color="yellow">◈ always on</Text>
    ) : working === m.id ? (
      <Text color="cyan">working…</Text>
    ) : (
      <Button key={`flip-${m.id}`} label={m.enabled ? '● On' : '○ Off'} variant={m.enabled ? 'primary' : undefined} onPress={() => toggle($, m.id, !m.enabled)} />
    )
  const commandButtons = (m: ModRow) =>
    m.commands.map(c => (
      <Box key={`cmd-${m.id}-${c.name}`} flexDirection="row">
        <Button key={`run-${c.name}`} label={`${mode === 'copy' ? '⧉' : '▶'} /${c.name}`} onPress={() => pressCommand($, c.name)} />
        {mode === 'copy' ? (
          <Button key={`alt-${c.name}`} label="▶" plain dimColor onPress={() => runCommand($, c.name)} />
        ) : (
          <Button key={`alt-${c.name}`} label="⧉" plain dimColor onPress={() => copyCommand($, c.name)} />
        )}
        <Button key={`pin-${c.name}`} label={s.pins.includes(c.name) ? '★' : '☆'} plain dimColor={!s.pins.includes(c.name)} onPress={() => togglePin($, c.name)} />
      </Box>
    ))
  const tags = (m: ModRow) => `  v${m.version} · @${m.marketplace}${isNew(m, now) ? ' · new' : ''}${s.pending.includes(m.id) ? ' · reload to apply' : ''}`

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
        <Text bold>{`${s.mods.length} mods · ${on} on${s.pending.length ? ` · ${s.pending.length} waiting` : ''}`}</Text>
        <Button key="hub" label={url ? '◈ Open Hub' : '◈ Start Hub'} onPress={() => void openHub($)} />
        {s.pending.length > 0 && <Button key="reload" label={`↻ Reload to apply (${s.pending.length})`} variant="primary" onPress={() => reload($)} />}
        <Button key="close" label="Close" plain dimColor role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>

      {Input && (
        <Input
          key="search"
          placeholder="Search mods and commands: every word must match…"
          value={v.query}
          submitLabel="search"
          onInput={q => setView($, { query: q })}
          onSubmit={q => setView($, { query: q })}
        />
      )}

      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {FILTERS.filter(f => f.value === 'all' || tally[f.value] > 0 || v.filter === f.value).map(f => (
          <Button
            key={`filter-${f.value}`}
            label={`${f.label} ${tally[f.value]}`}
            variant={v.filter === f.value ? 'primary' : undefined}
            plain={v.filter === f.value ? undefined : true}
            dimColor={v.filter !== f.value}
            onPress={() => setView($, { filter: f.value })}
          />
        ))}
      </Box>

      <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
        {Select && <Select key="sort" label="Sort" options={SORTS} value={v.sort} onSelect={value => setView($, { sort: value as View['sort'] })} />}
        {Select && markets.length > 1 && (
          <Select
            key="source"
            label="From"
            options={[{ value: '', label: 'Every marketplace' }, ...markets.map(m => ({ value: m, label: `@${m}` }))]}
            value={v.source}
            onSelect={value => setView($, { source: value })}
          />
        )}
        <Button key="layout" label={isCompact ? '▦ Detailed' : '▤ Compact'} plain onPress={() => setCompact($, !isCompact)} />
        <Button
          key="click-mode"
          label={mode === 'copy' ? 'Click: ⧉ Copy' : 'Click: ▶ Run'}
          variant={mode === 'copy' ? 'primary' : undefined}
          onPress={() => setClickMode($, mode === 'copy' ? 'run' : 'copy')}
        />
        {!isDefault(v) && <Button key="reset" label="✕ Reset view" plain dimColor onPress={() => setView($, { ...DEFAULT_VIEW })} />}
      </Box>

      {problem !== '' && (
        <Box flexDirection="row" columnGap={1}>
          <Text color="red" wrap="wrap">
            {problem}
          </Text>
          <Button key="dismiss-note" label="Dismiss" plain dimColor onPress={() => update($, note, () => '')} />
        </Box>
      )}

      {shown.length === 0 && (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>{`No mod is ${FILTERS.find(f => f.value === v.filter)?.hint ?? 'here'}${v.query ? ` and matches "${v.query}"` : ''}.`}</Text>
          <Button key="reset-empty" label="Show all" plain onPress={() => setView($, { ...DEFAULT_VIEW })} />
        </Box>
      )}

      {isCompact ? (
        <Box flexDirection="column">
          {shown.slice(p * per, (p + 1) * per).map(m => (
            <Box key={`row-${m.id}`} flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
              {flip(m)}
              <Text bold dimColor={!m.enabled} color={m.isSelf ? 'yellow' : undefined}>
                {m.isSelf ? `◈ ${m.name} (this mod)` : m.name}
              </Text>
              <Text dimColor>{tags(m)}</Text>
              {commandButtons(m)}
            </Box>
          ))}
        </Box>
      ) : (
        shown.slice(p * per, (p + 1) * per).map(m => (
          <Box key={`mod-${m.id}`} flexDirection="column" borderStyle={m.isSelf ? 'double' : 'round'} borderDimColor={!m.enabled} borderColor={m.isSelf ? 'yellow' : m.enabled ? 'green' : undefined} paddingX={1}>
            {m.isSelf && <Text color="yellow" bold>{'◈ THIS MOD · the Mod Manager you are using'}</Text>}
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <Text wrap="truncate-end">
                <Text bold dimColor={!m.enabled}>
                  {m.name}
                </Text>
                <Text dimColor>{tags(m)}</Text>
              </Text>
              {flip(m)}
            </Box>
            {m.description !== '' && (
              <Text dimColor wrap="wrap">
                {m.description.length > 160 ? `${m.description.slice(0, 159)}…` : m.description}
              </Text>
            )}
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
              {m.commands.length === 0 && <Text dimColor>{m.enabled ? 'No commands: it works by itself above the prompt or in hooks.' : 'Off.'}</Text>}
              {commandButtons(m)}
              <Button key={`open-${m.id}`} label="Open in Hub ↗" plain dimColor onPress={() => void openHub($, `#/mod/${encodeURIComponent(m.id)}`)} />
              {m.installedAt !== '' && <Text dimColor>{`installed ${since(m.installedAt, now)}`}</Text>}
            </Box>
          </Box>
        ))
      )}

      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Button key="prev" label="‹ Prev" plain dimColor={p === 0} onPress={() => update($, page, n => Math.max(0, n - 1))} />
        <Text dimColor>
          {shown.length === 0 ? 'nothing shown' : `${p * per + 1}–${Math.min(shown.length, (p + 1) * per)} of ${shown.length}${shown.length < s.mods.length ? ` (${s.mods.length} installed)` : ''}`}
        </Text>
        <Button key="next" label="Next ›" plain dimColor={p >= pages - 1} onPress={() => update($, page, n => Math.min(pages - 1, n + 1))} />
      </Box>
    </Box>
  )
}
