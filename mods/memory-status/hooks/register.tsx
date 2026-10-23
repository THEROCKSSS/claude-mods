// Memory Status: whether the Supabase memory Claude Code reads and writes is up, and how many
// writes wait in its degraded-mode queue.
//   - Every 30 s: the gateway over HTTP (any answer means up; it wants a key, so 401 is fine),
//     the containers memory needs (podman or docker ps), and the lines in pending.jsonl.
//   - A line above the prompt; /memory-status shows each container, recent changes, and the
//     targeted restart (only the critical services), to copy or to run with two presses.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Change, Reading } from '../types'
import { bandsFile, parseOrder, stackBands } from './bands'
import { countPending, discover, fixCommand, judge, parsePs } from './check'

const NAME = 'memory-status'
const PANE = 'memory-status'
const EVERY_MS = 30_000
const OPTIONAL = ['supabase-auth', 'supabase-meta']

const reading = atom({ plugin: 'memory-status', key: 'reading' } as const, null as Reading | null)
const history = atom({ plugin: 'memory-status', key: 'history' } as const, [] as Change[])
const fix = atom({ plugin: 'memory-status', key: 'fix' } as const, '')
const fixOutput = atom({ plugin: 'memory-status', key: 'fixOutput' } as const, '')
const armed = atom({ plugin: 'memory-status', key: 'armed' } as const, false)
const busy = atom({ plugin: 'memory-status', key: 'busy' } as const, false)

type Setup = { url: string; pendingFile: string; workspace: string; critical: string[]; runtime: string | null; isConfigured: boolean }

let options: { url: string; pendingFile: string; critical: string[]; onlyProblems: boolean } = { url: '', pendingFile: '', critical: [], onlyProblems: false }
let setup: Setup | null = null
let timer: Timer | undefined
let bandOrder: Promise<string[]> | undefined

export const register: Register = (on, opts) => {
  options = {
    url: typeof opts.url === 'string' ? opts.url.trim() : '',
    pendingFile: typeof opts.pendingFile === 'string' ? opts.pendingFile.trim() : '',
    critical: (typeof opts.critical === 'string' && opts.critical.trim() ? opts.critical : 'supabase-kong,supabase-rest,supabase-db').split(',').map(s => s.trim()).filter(Boolean),
    onlyProblems: opts.onlyProblems === true,
  }
  setup = null
  bandOrder = undefined

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'memory-status', description: 'Is the Supabase memory up? Each container, queued writes, and a fix' }).catch(() => {})
    timer?.cancel()
    timer = $.clock.every(EVERY_MS, () => {
      void check($).catch(() => {})
    })
    void check($).catch(() => {})
    return r
  })

  on('command.run', { command: 'memory-status' }, async $ => {
    await check($).catch(() => {})
    await $.ui.open({ id: PANE, title: 'Memory Status', focus: true })
    const r = await read($, reading)
    return { text: r ? `Memory ${r.verdict}${r.reason ? `: ${r.reason}` : ''} · ${r.pending} queued` : 'Memory Status opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const r = await read($, reading)
    if (e.props.hasSurvey || !r) return rest
    if (options.onlyProblems && r.verdict === 'ok' && r.pending === 0) return rest
    const { Box, Text, Button } = $.ui.resolve(e)
    const isOk = r.verdict === 'ok'
    const mine = (
      <Box flexDirection="row" columnGap={1} alignItems="center" paddingX={1}>
        <Text color={isOk ? 'success' : r.verdict === 'unknown' ? 'inactive' : 'error'} weight="semibold">
          {isOk ? '◉ memory ok' : r.verdict === 'unknown' ? '○ memory: no server found' : '◌ memory degraded'}
        </Text>
        {r.reason && !isOk && <Text dimColor>{`· ${r.reason}`}</Text>}
        <Text dimColor={r.pending === 0} color={r.pending > 0 ? 'warning' : undefined}>{`· ${r.pending} write${r.pending === 1 ? '' : 's'} queued`}</Text>
        {!isOk && r.verdict !== 'unknown' && <Button key="details" label="Fix…" plain onPress={() => $.ui.open({ id: PANE, title: 'Memory Status', focus: true })} />}
      </Box>
    )
    return stackBands(rest, NAME, mine, 'above', await (bandOrder ??= readBandOrder($).catch(() => [])))
  })
}

// ── Reading ───────────────────────────────────────────────────────────────

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

async function home($: EngineInterface): Promise<string> {
  return slash((await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined)) ?? '')
}

// Where memory lives and how to ask about it: settings first, else the supabase-memory MCP server's own.
async function findSetup($: EngineInterface): Promise<Setup> {
  if (setup) return setup
  const config = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  const file = config ? `${slash(config)}/.claude.json` : `${await home($)}/.claude.json`
  const text = await $.fs.read(file).catch(() => '')
  let found = null
  try {
    found = discover(JSON.parse(typeof text === 'string' ? text : ''))
  } catch {}
  let runtime: string | null = null
  for (const r of ['podman', 'docker']) {
    const v = await $.process.run([r, '--version'], { timeoutMs: 10_000 }).catch(() => null)
    if (v?.exitCode === 0) {
      runtime = r
      break
    }
  }
  const workspace = found?.workspace ?? ''
  setup = {
    url: options.url || found?.url || 'http://127.0.0.1:8100',
    pendingFile: options.pendingFile ? slash(options.pendingFile) : (found?.pendingFile ?? ''),
    workspace,
    critical: options.critical,
    runtime,
    isConfigured: Boolean(options.url || found),
  }
  const compose = workspace && (await $.fs.exists(`${workspace}/docker/core.yml`).catch(() => false)) ? `${workspace}/docker/core.yml` : ''
  await update($, fix, () => (runtime ? fixCommand(runtime, compose, options.critical) : ''))
  return setup
}

async function check($: EngineInterface) {
  const s = await findSetup($)
  const res = await $.http.fetch(`${s.url}/rest/v1/`).catch(() => null)
  const ps = s.runtime ? await $.process.run([s.runtime, 'ps', '-a', '--format', '{{.Names}}|{{.Status}}'], { timeoutMs: 20_000 }).catch(() => null) : null
  const queue = s.pendingFile ? await $.fs.read(s.pendingFile).catch(() => '') : ''
  const next = judge({
    at: await $.clock.now(),
    isConfigured: s.isConfigured,
    gatewayStatus: res ? res.status : null,
    ps: ps && ps.exitCode === 0 ? parsePs(ps.stdout) : null,
    critical: s.critical,
    optional: OPTIONAL,
    pending: typeof queue === 'string' ? countPending(queue) : 0,
  })
  const before = await read($, reading)
  await update($, reading, () => next)
  if (!before || before.verdict !== next.verdict) {
    await update($, history, h => [{ at: next.at, verdict: next.verdict, reason: next.reason }, ...h].slice(0, 8))
    if (before && next.verdict === 'degraded') $.ui.toast(`Memory degraded: ${next.reason}. /memory-status has the fix`)
    if (before?.verdict === 'degraded' && next.verdict === 'ok') $.ui.toast('Memory is back up')
  }
}

async function readBandOrder($: EngineInterface): Promise<string[]> {
  const file = bandsFile(await $.env.get('CLAUDE_CONFIG_DIR'), (await home($)) || undefined)
  return file && (await $.fs.exists(file)) ? parseOrder(await $.fs.read(file)) : []
}

// ── The fix ───────────────────────────────────────────────────────────────

async function copyFix($: EngineInterface) {
  const text = await read($, fix)
  const viaSurface = await $.ui.copy({ text }).catch(() => ({ isCopied: false }))
  const isWindows = /^[A-Za-z]:\//.test(slash($.plugin.root))
  const ok = viaSurface.isCopied || (await $.process.run(isWindows ? ['clip'] : ['pbcopy'], { stdin: text, timeoutMs: 5_000 }).catch(() => null))?.exitCode === 0
  $.ui.toast(ok ? 'Fix command copied' : `Copy it by hand: ${text}`)
}

// Runs the targeted restart, on the second press; reads memory again after.
async function runFix($: EngineInterface) {
  if (!(await read($, armed))) {
    await update($, armed, () => true)
    return
  }
  await update($, armed, () => false)
  await update($, busy, () => true)
  const command = await read($, fix)
  const isWindows = /^[A-Za-z]:\//.test(slash($.plugin.root))
  const r = await $.process.run(isWindows ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', command] : ['sh', '-c', command], { timeoutMs: 180_000 }).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  await update($, fixOutput, () => `${r.exitCode === 0 ? 'Done' : `Exit ${r.exitCode}`}: ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-4).join(' · ')}`)
  await update($, busy, () => false)
  await check($).catch(() => {})
}

// ── The pane ──────────────────────────────────────────────────────────────

export function ago(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`
}

async function drawPane($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const r = await read($, reading)
  const s = setup
  const now = await $.clock.now()
  const command = await read($, fix)
  const out = await read($, fixOutput)
  const isArmed = await read($, armed)
  const isBusy = await read($, busy)
  const changes = await read($, history)
  if (!r) return <Text dimColor>Checking memory…</Text>
  const tone = r.verdict === 'ok' ? 'success' : r.verdict === 'unknown' ? 'inactive' : 'error'
  const pill = (key: string, text: string, bg: string) => (
    <Text key={key} backgroundColor={bg} color="inverseText" weight="semibold" size="caption">
      {` ${text} `}
    </Text>
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2} flexWrap="wrap">
        <Box flexDirection="column">
          <Text size="title" weight="bold">
            <Text color={tone}>{r.verdict === 'ok' ? '◉ ' : '◌ '}</Text>
            {'Memory'}
          </Text>
          <Text size="footnote" dimColor>{`${r.verdict === 'ok' ? 'Up' : r.verdict === 'unknown' ? 'No memory server found' : `Degraded: ${r.reason}`} · checked ${ago(r.at, now)}`}</Text>
        </Box>
        <Box flexDirection="row" columnGap={1}>
          <Button key="check" label="↻ Check now" onPress={() => check($)} />
          <Button key="close" label="✕" plain dimColor role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
        <Text size="caption" weight="semibold" dimColor>
          GATEWAY
        </Text>
        <Box flexDirection="row" columnGap={1} alignItems="center">
          {pill('gw', r.gateway === 'up' ? 'UP' : r.gateway === 'error' ? 'ERROR' : 'DOWN', r.gateway === 'up' ? 'success' : 'error')}
          <Text mono>{s?.url ?? ''}</Text>
          <Text size="footnote" dimColor>{r.gatewayStatus === null ? 'no answer' : `answered ${r.gatewayStatus}${r.gatewayStatus === 401 ? ' (wants a key: it is up)' : ''}`}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
        <Text size="caption" weight="semibold" dimColor>
          {`CONTAINERS${s?.runtime ? ` · ${s.runtime}` : ' · no podman or docker found'}`}
        </Text>
        {r.containers.map(c => (
          <Box key={`c-${c.name}`} flexDirection="row" columnGap={1} alignItems="center">
            {pill(`cs-${c.name}`, c.isUp ? 'UP' : 'STOPPED', c.isUp ? 'success' : c.isCritical ? 'error' : 'inactive')}
            <Text weight={c.isCritical ? 'semibold' : undefined}>{c.name}</Text>
            <Text size="footnote" dimColor>{`${c.isCritical ? 'needed' : 'not needed for memory'} · ${c.status}`}</Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor={r.pending > 0 ? 'warning' : 'inactive'} paddingX={1}>
        <Text size="caption" weight="semibold" dimColor>
          QUEUED WRITES
        </Text>
        <Text>
          <Text size="heading" weight="semibold" color={r.pending > 0 ? 'warning' : undefined}>{String(r.pending)}</Text>
          <Text dimColor>{r.pending > 0 ? '  written while memory was down; they replay once it is back' : '  nothing waiting'}</Text>
        </Text>
        {s?.pendingFile ? <Text size="caption" mono dimColor>{s.pendingFile}</Text> : <Text size="caption" dimColor>No queue file known: set one in /plugin configure memory-status.</Text>}
      </Box>

      {command !== '' && (
        <Box flexDirection="column" borderStyle="round" borderColor={r.verdict === 'degraded' ? 'error' : 'inactive'} paddingX={1} gap={1}>
          <Text size="caption" weight="semibold" dimColor>
            FIX · restarts only what memory needs, never a blanket up or down
          </Text>
          <Text mono size="footnote" wrap="wrap">
            {command}
          </Text>
          <Box flexDirection="row" columnGap={1} alignItems="center">
            <Button key="copy-fix" label="⧉ Copy" onPress={() => copyFix($)} />
            {isBusy ? (
              <Text color="suggestion">running…</Text>
            ) : (
              <Button key="run-fix" label={isArmed ? 'Press again to run it' : '▶ Run fix'} variant={isArmed ? 'primary' : undefined} onPress={() => runFix($)} />
            )}
          </Box>
          {out !== '' && <Text size="footnote" dimColor wrap="wrap">{out}</Text>}
        </Box>
      )}

      {changes.length > 0 && (
        <Box flexDirection="column">
          <Text size="caption" weight="semibold" dimColor>
            RECENT CHANGES
          </Text>
          {changes.map((c, i) => (
            <Text key={`h-${i}`} size="footnote" dimColor={i > 0}>
              {`${ago(c.at, now)} · ${c.verdict}${c.reason ? ` · ${c.reason}` : ''}`}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}
