// Mod Hub: every installed mod in one place, without typing commands in chat.
//   - A bar above the prompt: ⚙ Mods opens the manager pane, ◈ Hub the web app, then a
//     button for each pinned command, and ↻ Reload once a mod was turned on or off.
//   - /mod-manager: a pane listing each mod with On/Off, a button per command, and pins.
//   - /hub: starts the local web app (server/hub.mjs) and opens it in the browser.
//   - Presets: named setups (mods on or off, pins, commands to run), saved and applied from
//     the pane or the hub. Claude can make them through the mod_presets tool; only the person applies.
//   - The bar shows how long the prompt cache stays warm after the last request.
//     The page only queues actions; this module checks each one against what is
//     installed and runs it: a command through $.command.run, On/Off through the
//     running Claude Code's `plugin enable|disable`, a reload through /reload-plugins.
import { atom, read, update } from 'claude-code'
import type { CommandInfo, EngineInterface, Register, Timer } from 'claude-code'

import type { HubState, ModRow } from '../types'
import { bandsFile, parseOrder, stackBands } from './bands'
import { cleanView, counts, DEFAULT_VIEW, FILTERS, isDefault, isNew, SORTS, sources, viewMods, type View } from '../shared/view'
import { cleanPreset, countdown, isToggle, plan, snapshot, summary, upsert, type Preset, type RecentCommand } from '../shared/presets'

const NAME = 'mod-hub'
const PANE = 'mod-hub'
const PER_PAGE = { cards: 6, compact: 12 }
const VIEW_KEY = 'view'
const TICK_MS = 1_500 // how often the hub is asked for actions while it runs
const REFRESH_MS = 15_000 // how often installed plugins are read again
const PINS_KEY = 'pins'
const DEFAULT_PINS = ['mod-logic', 'mission']
const SERVER_VERSION = 3 // server/hub.mjs SERVER_VERSION: a running hub below this is replaced
const PRESETS_KEY = 'presets'
const APPLY_KEY = 'pendingApply' // a preset whose commands wait for the reload its mods asked for
const TTL_KEY = 'cacheTtl'
const MIN5 = 5 * 60_000
const HOUR = 60 * 60_000
const MAX_RECENT = 12

const state = atom({ plugin: 'mod-hub', key: 'state' } as const, null as HubState | null)
const hubUrl = atom({ plugin: 'mod-hub', key: 'hubUrl' } as const, '')
const note = atom({ plugin: 'mod-hub', key: 'note' } as const, '')
const view = atom({ plugin: 'mod-hub', key: 'view' } as const, DEFAULT_VIEW as View)
const compact = atom({ plugin: 'mod-hub', key: 'compact' } as const, false)
const clickMode = atom({ plugin: 'mod-hub', key: 'clickMode' } as const, 'run' as 'run' | 'copy')
const page = atom({ plugin: 'mod-hub', key: 'page' } as const, 0)
const busy = atom({ plugin: 'mod-hub', key: 'busy' } as const, '')
const tab = atom({ plugin: 'mod-hub', key: 'tab' } as const, 'mods' as 'mods' | 'presets')
const editing = atom({ plugin: 'mod-hub', key: 'editing' } as const, '')
const confirmDelete = atom({ plugin: 'mod-hub', key: 'confirmDelete' } as const, '')
const draftName = atom({ plugin: 'mod-hub', key: 'draftName' } as const, '')
const recentAtom = atom({ plugin: 'mod-hub', key: 'recent' } as const, [] as RecentCommand[])
const cacheAt = atom({ plugin: 'mod-hub', key: 'cacheAt' } as const, 0)
const beat = atom({ plugin: 'mod-hub', key: 'beat' } as const, 0)

type Server = { port: number; host: string; token: string; pid: number }
type Action =
  | { seq: number; type: 'run'; command: string; args?: string }
  | { seq: number; type: 'toggle'; id: string; on: boolean }
  | { seq: number; type: 'reload' }
  | { seq: number; type: 'pins'; pins: string[] }
  | { seq: number; type: 'preset-save'; preset: unknown }
  | { seq: number; type: 'preset-delete'; id: string }
  | { seq: number; type: 'preset-apply'; id: string }
  | { seq: number; type: 'preset-snapshot'; name: string }

let port = 8796
let showBar = true
let timer: Timer | undefined
let ticks = 0
let lastSeq = 0
let lastPushed = ''
let isTurnRunning = false // a command run now waits for the turn to end; the person is told so
let pending: string[] = [] // module-level: a reload runs register again and empties it, which is right
let bandOrder: Promise<string[]> | undefined
let ttlMs = MIN5 // the cache lifetime: 5 min until a request shows it lasts an hour
let isTtlLearned = false
let ttlOverride: number | null = null
let beatTimer: Timer | undefined
let wasHubUp = false // only a hub that was up and went away is restarted on its own
let lastRestartAt = 0

export const register: Register = (on, options) => {
  port = typeof options.port === 'number' && options.port >= 1024 ? options.port : 8796
  showBar = options.showBar !== false
  ttlOverride = options.cacheTtl === '5m' ? MIN5 : options.cacheTtl === '1h' ? HOUR : null
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
    await restoreCache($).catch(() => {})
    await $.tool.register({
      name: 'mod_presets',
      description:
        "Make, change, list or delete the person's mod presets (mod-hub). A preset is a named setup: mods to turn on or off " +
        "(only the mods it names change), the bar's pinned commands, and slash commands to run when applied. Use action " +
        "'list' first: it shows the installed mods, their commands (toggles marked), the commands the person ran lately and " +
        "the presets so far. 'save' creates one (no id) or updates one (its id). You only save presets: the person applies " +
        'them from the Mod Manager or the hub. Leave commands marked as toggles off (enabled: false) unless asked.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'save', 'delete'] },
          id: { type: 'string', description: 'For delete: the preset id' },
          preset: {
            type: 'object',
            description: 'For save. Give id to update an existing preset.',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              note: { type: 'string', description: 'One line on what it is for' },
              mods: { type: 'object', description: 'plugin id (name@marketplace) to "on" or "off"', additionalProperties: { type: 'string', enum: ['on', 'off'] } },
              steps: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['command'] } },
              pins: { type: 'array', items: { type: 'string' }, description: 'Command names for the bar; leave out to keep the pins as they are' },
            },
            required: ['name'],
          },
        },
        required: ['action'],
      },
    }).catch(() => {})
    $.clock.after(1_500, () => void resumeApply($).catch(() => {})) // after the other mods have registered their commands
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

  // Every command the person runs, remembered for a preset's "save current setup".
  on('command.run', async ($, e, next) => {
    const r = await next(e)
    if (e.origin.kind !== 'plugin') await remember($, e.command, e.args ?? '').catch(() => {})
    return r
  })

  // Each main-thread model request restarts the prompt cache's clock.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId && result.usage) await sawRequest($, result.usage.cache_read_input_tokens).catch(() => {})
    return result
  })

  on('tool.call', { tool: 'mcp__mod-hub__mod_presets' }, async ($, e) => presetTool($, e as unknown as Record<string, unknown>))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!showBar || e.props.hasSurvey) return rest
    const s = await read($, state)
    const { Box, Button, Text } = $.ui.resolve(e)
    const runnable = new Set(allCommands(s).map(c => c.name))
    const pins = (s?.pins ?? []).filter(p => runnable.has(p))
    const cache = await cacheLine($)
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
          <Text color={cache.color} dimColor={cache.isDim}>
            {cache.text}
          </Text>
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
  const presets = await loadPresets($)
  const recent = await read($, recentAtom)
  const at = await read($, cacheAt)
  await update($, state, () => ({ ...build(commands, installed, enabled, pins, pending, version), presets, recent, cache: at ? { at, ttlMs, isLearned: isTtlLearned } : null }))
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
  return { generatedAt: Date.now(), claudeVersion, mods, otherCommands, pins, pending: [...pendingIds], presets: [], recent: [], cache: null }
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
  if (command !== 'reload-plugins') await remember($, command, args).catch(() => {})
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

// What a running hub says about itself; null when nothing answers as mod-hub.
async function ping($: EngineInterface, s: Server): Promise<{ pid: number; version: number } | null> {
  const r = await $.http.fetch(`http://127.0.0.1:${s.port}/api/ping`, { headers: { 'x-mod-hub-token': s.token } }).catch(() => null)
  if (r?.status !== 200) return null
  try {
    const p = JSON.parse(r.text) as { ok?: boolean; app?: string; pid?: number; version?: number }
    return p.ok && p.app === 'mod-hub' ? { pid: Number(p.pid ?? 0), version: Number(p.version ?? 1) } : null
  } catch {
    return null
  }
}

// Finds a running hub and remembers its address; '' when none answers. A hub older than this
// mod's server (left running across an update) is replaced, or it would keep serving the old API.
async function connect($: EngineInterface): Promise<string> {
  const s = await serverInfo($)
  let alive = s ? await ping($, s) : null
  if (s && alive && alive.version < SERVER_VERSION) {
    await replaceHub($, s, alive.pid)
    alive = null
    for (let i = 0; i < 20 && !alive; i++) {
      await $.clock.sleep(250)
      const fresh = await serverInfo($)
      alive = fresh ? await ping($, fresh) : null
    }
  }
  const info = alive ? await serverInfo($) : null
  const url = info && alive ? `http://127.0.0.1:${info.port}/` : ''
  await update($, hubUrl, () => url)
  return url
}

// Stops an old hub (by /api/shutdown, or for one too old to have it, by its pid: only the pid that
// answered as mod-hub and that server.json names) and starts this version's.
async function replaceHub($: EngineInterface, s: Server, pid: number) {
  const r = await $.http.fetch(`http://127.0.0.1:${s.port}/api/shutdown`, { method: 'POST', headers: { 'x-mod-hub-token': s.token } }).catch(() => null)
  if (r?.status !== 200 && pid > 0 && pid === s.pid) {
    const isWindows = /^[A-Za-z]:\//.test($.plugin.root.replace(/\\/g, '/'))
    await $.process.run(isWindows ? ['taskkill', '/PID', String(pid), '/F'] : ['kill', String(pid)], { timeoutMs: 10_000 }).catch(() => null)
  }
  await $.clock.sleep(400) // the port frees once the old process is gone
  await startServer($)
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
  // Detached, so the hub outlives this call and the session: on Windows WMI starts it as a child of
  // the WMI service, outside the app's process tree, so closing a window cannot take it down. nohup elsewhere.
  const line = ['node', ...args].map(a => `"${a}"`).join(' ').replace(/'/g, "''")
  const argv = isWindows
    ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${line}'; ProcessStartupInformation=$si}; if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine("WMI could not start node: $($r.ReturnValue)"); exit 1 }`]
    : ['sh', '-c', 'nohup node "$@" >/dev/null 2>&1 &', 'mod-hub', ...args]
  const r = await $.process.run(argv, { timeoutMs: 15_000 }).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  if (r.exitCode !== 0) {
    await update($, note, () => `could not start the hub (is Node.js installed?): ${r.stderr.trim().split('\n').slice(-1)[0]}`)
    return false
  }
  return true
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

// A hub that was up and went away is started again, at most once a minute; why it stopped is in hub.log.
async function restartLostHub($: EngineInterface) {
  if (!wasHubUp) return
  const now = await $.clock.now()
  if (now - lastRestartAt < 60_000) return
  lastRestartAt = now
  if (await startServer($)) $.ui.toast(`The Mod Hub stopped, so it was started again. Why it stopped: ${await configDir($)}/mod-hub/hub.log`)
}

// One beat: read plugins now and then; while the hub runs, send the state and run what it queued.
async function tick($: EngineInterface) {
  ticks++
  if (ticks % Math.round(REFRESH_MS / TICK_MS) === 0) await refresh($).catch(() => {})
  if (!(await read($, hubUrl))) {
    if (ticks % 10 === 0 && !(await connect($))) await restartLostHub($) // a hub started elsewhere joins within 15 s
    return
  }
  wasHubUp = true
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
  else if (a.type === 'preset-save') await savePreset($, a.preset, 'you')
  else if (a.type === 'preset-delete' && typeof a.id === 'string') await deletePreset($, a.id)
  else if (a.type === 'preset-apply' && typeof a.id === 'string') await applyPreset($, a.id)
  else if (a.type === 'preset-snapshot' && typeof a.name === 'string') await snapshotPreset($, a.name)
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

// The strip under the pane's title: one rounded bar split into on, waiting on a reload, and off.
export function statusStrip(on: number, changed: number, off: number): string {
  const W = 860
  const H = 54
  const total = Math.max(1, on + changed + off)
  const parts = [
    { n: on, color: '#e3a857', label: 'on' },
    { n: changed, color: '#e8d27a', label: 'waiting on a reload' },
    { n: off, color: '#6b645a', label: 'off' },
  ].filter(p => p.n > 0)
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, system-ui, sans-serif">`]
  o.push(`<rect x="0" y="6" width="${W}" height="12" rx="6" fill="#2b2620"/>`)
  let x = 0
  parts.forEach((p, i) => {
    const w = (p.n / total) * W
    const isFirst = i === 0
    const isLast = i === parts.length - 1
    o.push(`<rect x="${x.toFixed(1)}" y="6" width="${Math.max(2, w - (isLast ? 0 : 3)).toFixed(1)}" height="12" rx="${isFirst || isLast ? 6 : 2}" fill="${p.color}"/>`)
    x += w
  })
  let lx = 0
  for (const p of parts) {
    o.push(`<circle cx="${lx + 5}" cy="40" r="4.5" fill="${p.color}"/>`)
    o.push(`<text x="${lx + 15}" y="44.5" font-size="13" fill="#b9b1a2"><tspan font-weight="700" fill="#ece6da">${p.n}</tspan> ${p.label}</text>`)
    lx += 36 + String(p.n).length * 7.8 + p.label.length * 6.3 // 13 px Segoe: digits bold, words regular
  }
  o.push('</svg>')
  return o.join('')
}

async function drawPane($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const Input = 'Input' in elements ? elements.Input : undefined
  const Select = 'Select' in elements ? elements.Select : undefined
  const Svg = 'Svg' in elements ? elements.Svg : undefined
  const s = await read($, state)
  if (!s) return <Text dimColor>Reading your mods…</Text>
  if ((await read($, tab)) === 'presets') return drawPresets($, e, s)
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
  const changedCount = s.pending.length

  const pill = (key: string, text: string, bg: string) => (
    <Text key={key} backgroundColor={bg} color="inverseText" weight="semibold" size="caption">
      {` ${text} `}
    </Text>
  )
  const flip = (m: ModRow) =>
    m.isSelf ? (
      pill('self-on', '◈ ALWAYS ON', 'claude')
    ) : working === m.id ? (
      <Text color="suggestion">switching…</Text>
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
  const badges = (m: ModRow) => [
    m.isSelf ? pill(`b-self-${m.id}`, 'THIS MOD', 'claude') : null,
    isNew(m, now) ? pill(`b-new-${m.id}`, 'NEW', 'success') : null,
    s.pending.includes(m.id) ? pill(`b-chg-${m.id}`, 'RELOAD TO APPLY', 'warning') : null,
  ]

  return (
    <Box flexDirection="column" gap={1}>
      {/* Header: the name, one line of status, and the pane's actions. */}
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" columnGap={2}>
        <Box flexDirection="column">
          <Text size="title" weight="bold">
            <Text color="claude">{'▣ '}</Text>
            {'Mod Manager'}
          </Text>
          <Text size="footnote" dimColor>
            {`${s.mods.length} installed · ${on} on${changedCount ? ` · ${changedCount} waiting on a reload` : ''}${url ? ' · hub running' : ''}`}
          </Text>
        </Box>
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Button key="tab-mods" label="▣ Mods" variant="primary" onPress={() => update($, tab, () => 'mods')} />
          <Button key="tab-presets" label={`★ Presets${s.presets.length ? ` · ${s.presets.length}` : ''}`} plain onPress={() => update($, tab, () => 'presets')} />
          {changedCount > 0 && <Button key="reload" label={`↻ Reload · ${changedCount}`} variant="primary" onPress={() => reload($)} />}
          <Button key="hub" label={url ? '◈ Open Hub' : '◈ Start Hub'} onPress={() => void openHub($)} />
          <Button key="close" label="✕" plain dimColor role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>

      {Svg && (
        <Svg
          key="strip"
          source={statusStrip(
            s.mods.filter(m => m.enabled && !s.pending.includes(m.id)).length,
            changedCount,
            s.mods.filter(m => !m.enabled && !s.pending.includes(m.id)).length,
          )}
          alt={`${on} of ${s.mods.length} mods on`}
        />
      )}

      {/* Toolbar: search, filters and view settings in one card. */}
      <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1} gap={1}>
        {Input && (
          <Input key="search" placeholder="Search mods and commands…" value={v.query} submitLabel="search" onInput={q => setView($, { query: q })} onSubmit={q => setView($, { query: q })} />
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
          <Button key="layout" label={isCompact ? '▦ Cards' : '▤ Compact'} plain onPress={() => setCompact($, !isCompact)} />
          <Button key="click-mode" label={mode === 'copy' ? 'Click: ⧉ Copy' : 'Click: ▶ Run'} variant={mode === 'copy' ? 'primary' : undefined} onPress={() => setClickMode($, mode === 'copy' ? 'run' : 'copy')} />
          {!isDefault(v) && <Button key="reset" label="✕ Reset" plain dimColor onPress={() => setView($, { ...DEFAULT_VIEW })} />}
        </Box>
      </Box>

      {problem !== '' && (
        <Box flexDirection="row" columnGap={1} borderStyle="round" borderColor="error" paddingX={1}>
          <Text color="error" wrap="wrap">
            {problem}
          </Text>
          <Button key="dismiss-note" label="Dismiss" plain dimColor onPress={() => update($, note, () => '')} />
        </Box>
      )}

      <Text size="caption" weight="semibold" dimColor>
        {shown.length === 0 ? 'NOTHING SHOWN' : `SHOWING ${p * per + 1}–${Math.min(shown.length, (p + 1) * per)} OF ${shown.length}${shown.length < s.mods.length ? ` · ${s.mods.length} INSTALLED` : ''}`}
      </Text>

      {shown.length === 0 && (
        <Box flexDirection="column" alignItems="center" borderStyle="round" borderColor="inactive" paddingY={1}>
          <Text dimColor>{`No mod is ${FILTERS.find(f => f.value === v.filter)?.hint ?? 'here'}${v.query ? ` and matches "${v.query}"` : ''}.`}</Text>
          <Button key="reset-empty" label="Show all mods" plain onPress={() => setView($, { ...DEFAULT_VIEW })} />
        </Box>
      )}

      {isCompact ? (
        <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
          {shown.slice(p * per, (p + 1) * per).map(m => (
            <Box key={`row-${m.id}`} flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
              {flip(m)}
              <Text weight="semibold" dimColor={!m.enabled} color={m.isSelf ? 'claude' : undefined}>
                {m.isSelf ? `◈ ${m.name}` : m.name}
              </Text>
              {badges(m)}
              {commandButtons(m)}
            </Box>
          ))}
        </Box>
      ) : (
        shown.slice(p * per, (p + 1) * per).map(m => (
          <Box
            key={`mod-${m.id}`}
            flexDirection="column"
            borderStyle={m.isSelf ? 'double' : 'round'}
            borderColor={m.isSelf ? 'claude' : m.enabled ? 'success' : 'inactive'}
            borderDimColor={!m.enabled && !m.isSelf}
            hover={{ borderColor: 'claude', borderDimColor: false }}
            paddingX={1}
          >
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
              <Text wrap="truncate-end">
                <Text size="heading" weight="semibold" dimColor={!m.enabled} color={m.isSelf ? 'claude' : undefined}>
                  {m.isSelf ? `◈ ${m.name}` : m.name}
                </Text>
                <Text size="footnote" mono dimColor>{`  v${m.version}`}</Text>
              </Text>
              {flip(m)}
            </Box>
            {badges(m).some(Boolean) && (
              <Box flexDirection="row" columnGap={1}>
                {badges(m)}
              </Box>
            )}
            {m.isSelf && (
              <Text size="footnote" color="claude">
                The Mod Manager you are using. It stays on so you can always get back here.
              </Text>
            )}
            {m.description !== '' && (
              <Text size="footnote" dimColor wrap="wrap">
                {m.description.length > 170 ? `${m.description.slice(0, 169)}…` : m.description}
              </Text>
            )}
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
              {m.commands.length === 0 && <Text size="footnote" dimColor italic>{m.enabled ? 'No commands: it works by itself, above the prompt or in hooks.' : 'Off: its commands come back once it is on and reloaded.'}</Text>}
              {commandButtons(m)}
            </Box>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <Text size="caption" dimColor>
                {`@${m.marketplace}${m.installedAt ? ` · installed ${since(m.installedAt, now)}` : ''}`}
              </Text>
              <Button key={`open-${m.id}`} label="Open in Hub ↗" plain dimColor onPress={() => void openHub($, `#/mod/${encodeURIComponent(m.id)}`)} />
            </Box>
          </Box>
        ))
      )}

      {pages > 1 && (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Button key="prev" label="‹ Prev" plain dimColor={p === 0} onPress={() => update($, page, n => Math.max(0, n - 1))} />
          <Text size="footnote" dimColor tabular>{`page ${p + 1} of ${pages}`}</Text>
          <Button key="next" label="Next ›" plain dimColor={p >= pages - 1} onPress={() => update($, page, n => Math.min(pages - 1, n + 1))} />
        </Box>
      )}
    </Box>
  )
}

// ── Recent commands ───────────────────────────────────────────────────────

async function remember($: EngineInterface, command: string, args: string) {
  const at = await $.clock.now()
  const list = await update($, recentAtom, prev => [{ command, args: args.trim(), at }, ...prev.filter(r => !(r.command === command && r.args === args.trim()))].slice(0, MAX_RECENT))
  await update($, state, prev => (prev ? { ...prev, recent: list } : prev))
}

// ── The prompt cache ──────────────────────────────────────────────────────

async function restoreCache($: EngineInterface) {
  if (ttlOverride !== null) {
    ttlMs = ttlOverride
    isTtlLearned = true
    return
  }
  const known = await $.store.get(TTL_KEY).catch(() => undefined)
  if (known === '1h') {
    ttlMs = HOUR
    isTtlLearned = true
  }
  if ((await read($, cacheAt)) > 0) startBeat($)
}

// A request finished. One that still read from the cache more than five minutes after the
// last shows the cache lasts an hour here; that is remembered for later sessions.
async function sawRequest($: EngineInterface, cacheRead: number) {
  const now = await $.clock.now()
  const prev = await read($, cacheAt)
  if (ttlOverride === null && ttlMs < HOUR && prev > 0 && now - prev > MIN5 + 10_000 && now - prev < HOUR && cacheRead > 0) {
    ttlMs = HOUR
    isTtlLearned = true
    await $.store.set(TTL_KEY, '1h').catch(() => {})
  }
  await update($, cacheAt, () => now)
  await update($, state, prev2 => (prev2 ? { ...prev2, cache: { at: now, ttlMs, isLearned: isTtlLearned } } : prev2))
  startBeat($)
}

// Ticks once a second while the cache is warm, so the bar's countdown moves; stops once it is cold.
function startBeat($: EngineInterface) {
  beatTimer?.cancel()
  beatTimer = $.clock.every(1_000, () => {
    void tickBeat($).catch(() => {})
  })
}

async function tickBeat($: EngineInterface) {
  const at = await read($, cacheAt)
  if (!at || (await $.clock.now()) - at > ttlMs) {
    beatTimer?.cancel()
    beatTimer = undefined
  }
  await update($, beat, n => n + 1)
}

// The bar's cache part: how long it stays warm, or that it went cold.
async function cacheLine($: EngineInterface): Promise<{ text: string; color?: string; isDim: boolean }> {
  await read($, beat) // redraws each second while warm
  const at = await read($, cacheAt)
  if (!at) return { text: '◷ cache · no request yet', isDim: true }
  const left = at + ttlMs - (await $.clock.now())
  const life = ttlMs >= HOUR ? '1 h' : '5 min'
  if (left <= 0) return { text: `◷ cache cold · next message re-reads it (${life} cache)`, isDim: true }
  return { text: `◷ cache warm · ${countdown(left)} left`, color: left <= 60_000 ? 'warning' : 'success', isDim: false }
}

// ── Presets: storing ──────────────────────────────────────────────────────

async function loadPresets($: EngineInterface): Promise<Preset[]> {
  const raw = await $.store.get(PRESETS_KEY).catch(() => undefined)
  const now = await $.clock.now()
  return (Array.isArray(raw) ? raw : []).map(p => cleanPreset(p, now)).filter((p): p is Preset => p !== null && p.id !== '')
}

async function storePresets($: EngineInterface, list: Preset[]) {
  await $.store.set(PRESETS_KEY, list).catch(() => {})
  await update($, state, prev => (prev ? { ...prev, presets: list } : prev))
}

// Saves one (new, or by its id); returns it as stored, or null when it was not a preset.
async function savePreset($: EngineInterface, raw: unknown, by: 'you' | 'claude'): Promise<Preset | null> {
  const now = await $.clock.now()
  const clean = cleanPreset(raw, now)
  if (!clean) return null
  const list = upsert(await loadPresets($), { ...clean, by: by === 'claude' ? 'claude' : clean.by }, now)
  await storePresets($, list)
  return list.find(p => p.name === clean.name && (clean.id ? p.id === clean.id : true)) ?? list.at(-1) ?? null
}

async function deletePreset($: EngineInterface, id: string) {
  await storePresets($, (await loadPresets($)).filter(p => p.id !== id))
  if ((await read($, editing)) === id) await update($, editing, () => '')
}

// Changes one preset in place.
async function editPreset($: EngineInterface, id: string, change: (p: Preset) => Preset) {
  const list = await loadPresets($)
  const now = await $.clock.now()
  await storePresets($, list.map(p => (p.id === id ? { ...change(p), id, updatedAt: now } : p)))
}

// The current setup, saved under a name.
async function snapshotPreset($: EngineInterface, name: string) {
  const s = await read($, state)
  const clean = name.trim().slice(0, 60)
  if (!s || !clean) {
    $.ui.toast('Give the preset a name first')
    return
  }
  const saved = await savePreset($, snapshot(clean, s.mods, s.pins, await read($, recentAtom), await $.clock.now()), 'you')
  await update($, draftName, () => '')
  if (saved) {
    await update($, editing, () => saved.id)
    $.ui.toast(`Saved preset "${saved.name}": ${summary(saved)}`)
  }
}

// ── Presets: applying ─────────────────────────────────────────────────────

// Turns its mods on or off, sets its pins, and runs its commands. A mod change needs a reload
// first, so the commands are kept for after it and run once the mods are back.
async function applyPreset($: EngineInterface, id: string) {
  const s = await read($, state)
  const preset = (await loadPresets($)).find(p => p.id === id)
  if (!s || !preset) return
  const { flips, steps, missing } = plan(preset, s.mods.filter(m => !m.isSelf))
  for (const f of flips) await toggle($, f.id, f.on)
  if (preset.pins) await setPins($, preset.pins)
  if (missing.length) $.ui.toast(`${preset.name}: ${missing.length} of its mods are not installed here, so they were skipped`)
  if (flips.length > 0) {
    await $.store.set(APPLY_KEY, { id, at: await $.clock.now() }).catch(() => {})
    $.ui.toast(`Applying ${preset.name}: reloading for ${flips.length} mod${flips.length === 1 ? '' : 's'}${steps.length ? `, then running ${steps.length} command${steps.length === 1 ? '' : 's'}` : ''}`)
    await reload($)
    return
  }
  await runSteps($, preset)
}

async function runSteps($: EngineInterface, preset: Preset) {
  const steps = preset.steps.filter(x => x.enabled)
  for (const step of steps) await runCommand($, step.command, step.args)
  $.ui.toast(steps.length ? `${preset.name} applied: ran ${steps.map(x => `/${x.command}`).join(', ')}` : `${preset.name} applied`)
}

// After the reload a preset asked for: run the commands it still owes, once, if it was recent.
async function resumeApply($: EngineInterface) {
  const owed = (await $.store.get(APPLY_KEY).catch(() => undefined)) as { id?: string; at?: number } | undefined
  if (!owed?.id) return
  await $.store.delete(APPLY_KEY).catch(() => {})
  if ((await $.clock.now()) - (owed.at ?? 0) > 120_000) return
  const preset = (await loadPresets($)).find(p => p.id === owed.id)
  if (preset) await runSteps($, preset)
}

// ── Presets: Claude's tool ────────────────────────────────────────────────

async function presetTool($: EngineInterface, input: Record<string, unknown>) {
  const s = await read($, state)
  if (!s) return { deny: 'mod-hub is still reading the installed mods; try again in a moment.' }
  const action = input.action
  if (action === 'list') {
    const mods = s.mods
      .filter(m => !m.isSelf)
      .map(m => `- ${m.id} (${m.enabled ? 'on' : 'off'})${m.commands.length ? `: ${m.commands.map(c => `/${c.name}${isToggle(c.description) ? ' [toggle]' : ''}`).join(', ')}` : ''}`)
    const presets = s.presets.map(p => `- ${p.id} "${p.name}" by ${p.by}: ${summary(p)}`)
    const recent = s.recent.map(r => `/${r.command}${r.args ? ` ${r.args}` : ''}`)
    return {
      result: [
        `Installed mods (${s.mods.length - 1}):`,
        ...mods,
        '',
        `Recently run: ${recent.length ? recent.join(', ') : 'nothing yet'}`,
        `Pins on the bar: ${s.pins.map(x => `/${x}`).join(', ') || 'none'}`,
        '',
        presets.length ? `Presets (${presets.length}):` : 'No presets yet.',
        ...presets,
      ].join('\n'),
    }
  }
  if (action === 'delete') {
    const id = typeof input.id === 'string' ? input.id : ''
    if (!s.presets.some(p => p.id === id)) return { deny: `No preset with id ${id}. Use action list to see them.` }
    await deletePreset($, id)
    return { result: `Deleted preset ${id}.` }
  }
  if (action === 'save') {
    const clean = cleanPreset(input.preset, await $.clock.now())
    if (!clean) return { deny: 'A preset needs at least a name. Mods map plugin ids to "on" or "off"; steps are { command, args, enabled }.' }
    const ids = new Set(s.mods.map(m => m.id))
    const unknownMods = Object.keys(clean.mods).filter(id => !ids.has(id))
    const known = new Set([...s.mods.flatMap(m => m.commands.map(c => c.name)), ...s.otherCommands.map(c => c.name)])
    const unknownSteps = clean.steps.filter(x => !known.has(x.command)).map(x => `/${x.command}`)
    if (unknownMods.length) return { deny: `Not installed here: ${unknownMods.join(', ')}. Use action list for the plugin ids.` }
    const saved = await savePreset($, clean, 'claude')
    if (!saved) return { deny: 'That preset could not be saved.' }
    return {
      result:
        `Saved preset "${saved.name}" (id ${saved.id}): ${summary(saved)}.` +
        (unknownSteps.length ? ` Note: ${unknownSteps.join(', ')} ${unknownSteps.length === 1 ? 'is' : 'are'} not a command right now; it runs only if its mod is on when the preset is applied.` : '') +
        ' The person applies it from ★ Presets in the Mod Manager, or the hub.',
    }
  }
  return { deny: 'action must be list, save or delete' }
}

// ── Presets: the pane ─────────────────────────────────────────────────────

async function drawPresets($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], s: HubState) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const Input = 'Input' in elements ? elements.Input : undefined
  const open = await read($, editing)
  const doomed = await read($, confirmDelete)
  const name = await read($, draftName)
  const recent = await read($, recentAtom)
  const describe = new Map(s.mods.flatMap(m => m.commands.map(c => [c.name, c.description] as const)))
  const known = new Set([...describe.keys(), ...s.otherCommands.map(c => c.name)])
  const others = s.mods.filter(m => !m.isSelf)

  const pill = (key: string, text: string, bg: string) => (
    <Text key={key} backgroundColor={bg} color="inverseText" weight="semibold" size="caption">
      {` ${text} `}
    </Text>
  )
  const caption = (key: string, text: string) => (
    <Text key={key} size="caption" weight="semibold" dimColor>
      {text}
    </Text>
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" columnGap={2}>
        <Box flexDirection="column">
          <Text size="title" weight="bold">
            <Text color="claude">{'★ '}</Text>
            {'Presets'}
          </Text>
          <Text size="footnote" dimColor>
            {s.presets.length ? `${s.presets.length} saved · apply one to switch your whole setup` : 'Save a setup once, switch back to it in one press'}
          </Text>
        </Box>
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Button key="tab-mods" label="▣ Mods" plain onPress={() => update($, tab, () => 'mods')} />
          <Button key="tab-presets" label={`★ Presets${s.presets.length ? ` · ${s.presets.length}` : ''}`} variant="primary" onPress={() => update($, tab, () => 'presets')} />
          <Button key="close" label="✕" plain dimColor role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>

      {/* New preset: the current setup under a name. */}
      <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} gap={1}>
        <Text size="heading" weight="semibold">
          New preset from your current setup
        </Text>
        <Text size="footnote" dimColor wrap="wrap">
          {`Keeps every mod's on or off, your ${s.pins.length} pin${s.pins.length === 1 ? '' : 's'}, and the commands you ran lately${recent.length ? `: ${recent.slice(0, 6).map(r => `/${r.command}${r.args ? ` ${r.args}` : ''}`).join(', ')}` : ' (none yet: run some, or add them after)'}. Toggles go in unticked.`}
        </Text>
        <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
          {Input && <Input key="new-name" placeholder="Name it: Focus, Streaming, Everything on…" value={name} submitLabel="save" onInput={v => update($, draftName, () => v)} onSubmit={v => snapshotPreset($, v)} />}
          <Button key="snapshot" label="★ Save current setup" variant="primary" onPress={async () => snapshotPreset($, await read($, draftName))} />
        </Box>
        <Text size="caption" dimColor>
          Or ask Claude: "make me a preset for streaming with snake off". It can save presets for you; only you apply them.
        </Text>
      </Box>

      {s.presets.length === 0 && (
        <Box flexDirection="column" alignItems="center" borderStyle="round" borderColor="inactive" paddingY={1}>
          <Text dimColor>No presets yet.</Text>
        </Box>
      )}

      {s.presets.map(p => {
        const isOpen = open === p.id
        const { flips, steps, missing } = plan(p, others)
        const willDo = [
          flips.length ? `turn ${flips.filter(f => f.on).length ? `${flips.filter(f => f.on).length} on` : ''}${flips.filter(f => f.on).length && flips.filter(f => !f.on).length ? ', ' : ''}${flips.filter(f => !f.on).length ? `${flips.filter(f => !f.on).length} off` : ''} (then reload)` : '',
          steps.length ? `run ${steps.length} command${steps.length === 1 ? '' : 's'}` : '',
          p.pins ? 'set the pins' : '',
        ].filter(Boolean)
        return (
          <Box key={`preset-${p.id}`} flexDirection="column" borderStyle="round" borderColor={isOpen ? 'claude' : 'inactive'} hover={{ borderColor: 'claude' }} paddingX={1}>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1} flexWrap="wrap">
              <Box flexDirection="row" columnGap={1} alignItems="center">
                <Text size="heading" weight="semibold">
                  {p.name}
                </Text>
                {p.by === 'claude' && pill(`by-${p.id}`, 'BY CLAUDE', 'suggestion')}
              </Box>
              <Box flexDirection="row" columnGap={1} alignItems="center">
                <Button key={`apply-${p.id}`} label="▶ Apply" variant="primary" onPress={() => applyPreset($, p.id)} />
                <Button key={`edit-${p.id}`} label={isOpen ? '✓ Done' : '✎ Edit'} plain onPress={() => update($, editing, cur => (cur === p.id ? '' : p.id))} />
                <Button key={`copy-${p.id}`} label="⧉" plain dimColor onPress={() => savePreset($, { ...p, id: '', name: `${p.name} copy`, by: 'you' }, 'you')} />
                <Button
                  key={`delete-${p.id}`}
                  label={doomed === p.id ? 'Press again to delete' : '✕'}
                  plain={doomed === p.id ? undefined : true}
                  variant={doomed === p.id ? 'primary' : undefined}
                  dimColor={doomed !== p.id}
                  onPress={async () => {
                    if ((await read($, confirmDelete)) === p.id) {
                      await deletePreset($, p.id)
                      await update($, confirmDelete, () => '')
                    } else await update($, confirmDelete, () => p.id)
                  }}
                />
              </Box>
            </Box>
            {p.note !== '' && (
              <Text size="footnote" dimColor wrap="wrap">
                {p.note}
              </Text>
            )}
            <Text size="footnote" wrap="wrap">
              {summary(p)}
            </Text>
            <Text size="caption" dimColor wrap="wrap">
              {willDo.length ? `Applying now would ${willDo.join(', ')}.` : 'Applying now changes nothing: everything already matches.'}
              {missing.length ? ` ${missing.length} of its mods are not installed here.` : ''}
            </Text>

            {isOpen && (
              <Box flexDirection="column" gap={1} paddingTop={1}>
                {Input && (
                  <Input key={`rename-${p.id}`} label="Name" placeholder="Preset name" value={p.name} submitLabel="rename" onSubmit={v => editPreset($, p.id, x => ({ ...x, name: v.trim() || x.name }))} />
                )}
                {Input && <Input key={`note-${p.id}`} label="Note" placeholder="What it is for (optional)" value={p.note} submitLabel="save" onSubmit={v => editPreset($, p.id, x => ({ ...x, note: v.slice(0, 300) }))} />}

                {caption(`cap-mods-${p.id}`, 'MODS  ·  leave as is, or turn on or off when applied')}
                {others.map(m => {
                  const want = p.mods[m.id]
                  const set = (v: 'on' | 'off' | undefined) =>
                    editPreset($, p.id, x => {
                      const mods = { ...x.mods }
                      if (v) mods[m.id] = v
                      else delete mods[m.id]
                      return { ...x, mods }
                    })
                  return (
                    <Box key={`pm-${p.id}-${m.id}`} flexDirection="row" columnGap={1} alignItems="center">
                      <Button key={`pm-leave-${m.id}`} label="·" variant={!want ? 'primary' : undefined} plain={want ? true : undefined} dimColor={!!want} onPress={() => set(undefined)} />
                      <Button key={`pm-on-${m.id}`} label="On" variant={want === 'on' ? 'primary' : undefined} plain={want === 'on' ? undefined : true} dimColor={want !== 'on'} onPress={() => set('on')} />
                      <Button key={`pm-off-${m.id}`} label="Off" variant={want === 'off' ? 'primary' : undefined} plain={want === 'off' ? undefined : true} dimColor={want !== 'off'} onPress={() => set('off')} />
                      <Text weight={want ? 'semibold' : undefined} dimColor={!want}>
                        {m.name}
                      </Text>
                      <Text size="caption" dimColor>{m.enabled ? 'now on' : 'now off'}</Text>
                    </Box>
                  )
                })}

                {caption(`cap-steps-${p.id}`, 'COMMANDS  ·  run in order when applied')}
                {p.steps.length === 0 && <Text size="footnote" dimColor>None yet. Add one below.</Text>}
                {p.steps.map((step, i) => {
                  const toggleLike = isToggle(describe.get(step.command) ?? '')
                  const move = (to: number) =>
                    editPreset($, p.id, x => {
                      const list = [...x.steps]
                      const [one] = list.splice(i, 1)
                      list.splice(Math.max(0, Math.min(list.length, to)), 0, one!)
                      return { ...x, steps: list }
                    })
                  return (
                    <Box key={`ps-${p.id}-${i}`} flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
                      <Button key={`ps-tick-${i}`} label={step.enabled ? '☑' : '☐'} plain onPress={() => editPreset($, p.id, x => ({ ...x, steps: x.steps.map((y, j) => (j === i ? { ...y, enabled: !y.enabled } : y)) }))} />
                      <Text mono dimColor={!step.enabled}>{`/${step.command}${step.args ? ` ${step.args}` : ''}`}</Text>
                      {toggleLike && pill(`ps-tg-${i}`, '⇄ TOGGLE', 'warning')}
                      {!known.has(step.command) && pill(`ps-nk-${i}`, 'NOT A COMMAND NOW', 'error')}
                      <Button key={`ps-up-${i}`} label="↑" plain dimColor onPress={() => move(i - 1)} />
                      <Button key={`ps-down-${i}`} label="↓" plain dimColor onPress={() => move(i + 1)} />
                      <Button key={`ps-rm-${i}`} label="✕" plain dimColor onPress={() => editPreset($, p.id, x => ({ ...x, steps: x.steps.filter((_, j) => j !== i) }))} />
                    </Box>
                  )
                })}
                {Input && (
                  <Input
                    key={`add-${p.id}`}
                    placeholder="Add a command: cache-clock setup, heatmap, mission code…"
                    submitLabel="add"
                    onSubmit={v => {
                      const [command = '', ...rest] = v.trim().replace(/^\//, '').split(/\s+/)
                      if (!command) return
                      return editPreset($, p.id, x => ({ ...x, steps: [...x.steps, { command, args: rest.join(' '), enabled: !isToggle(describe.get(command) ?? '') }].slice(0, 20) }))
                    }}
                  />
                )}
                {recent.length > 0 && (
                  <Box flexDirection="row" columnGap={1} flexWrap="wrap" alignItems="center">
                    {caption(`cap-recent-${p.id}`, 'RECENT')}
                    {recent.slice(0, 8).map(r => (
                      <Button
                        key={`add-recent-${p.id}-${r.command}-${r.args}`}
                        label={`+ /${r.command}${r.args ? ` ${r.args}` : ''}`}
                        plain
                        onPress={() => editPreset($, p.id, x => ({ ...x, steps: [...x.steps, { command: r.command, args: r.args, enabled: !isToggle(describe.get(r.command) ?? '') }].slice(0, 20) }))}
                      />
                    ))}
                  </Box>
                )}

                {caption(`cap-pins-${p.id}`, 'PINS ON THE BAR')}
                <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
                  <Button key={`pins-keep-${p.id}`} label="Leave as they are" variant={p.pins === null ? 'primary' : undefined} plain={p.pins === null ? undefined : true} onPress={() => editPreset($, p.id, x => ({ ...x, pins: null }))} />
                  <Button key={`pins-now-${p.id}`} label={`Use my current pins (${s.pins.length})`} variant={p.pins !== null ? 'primary' : undefined} plain={p.pins !== null ? undefined : true} onPress={() => editPreset($, p.id, x => ({ ...x, pins: [...s.pins] }))} />
                  {p.pins !== null && <Text size="footnote" dimColor>{p.pins.length ? p.pins.map(x => `/${x}`).join(' ') : 'clears the pins'}</Text>}
                </Box>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
