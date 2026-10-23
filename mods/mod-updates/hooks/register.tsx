// Mod Updates: which installed mods have a newer version, what changed, and one click to update.
//   - A marketplace cloned from git is fetched (git fetch only: nothing it holds is reset) and each
//     of its mods compared: the version listed upstream, and the commits that touched the mod's
//     folder since the commit it was installed from.
//   - A folder marketplace is read live, so its mods already run what the folder holds; an update
//     there records the folder's version.
//   - /mod-updates lists them; Update runs the session's own `claude plugin update`, then a reload.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Row } from '../types'
import { bandsFile, parseOrder, stackBands } from './bands'
import { isNewer, parseLog, readCatalog, readInstalled, readMarkets, sortRows } from './updates'

const NAME = 'mod-updates'
const PANE = 'mod-updates'
const FIRST_CHECK_MS = 20_000 // after the session settles, so the fetch never slows its start
const MAX_COMMITS = 30

const rows = atom({ plugin: 'mod-updates', key: 'rows' } as const, [] as Row[])
const checkedAt = atom({ plugin: 'mod-updates', key: 'checkedAt' } as const, 0)
const checking = atom({ plugin: 'mod-updates', key: 'checking' } as const, false)
const updating = atom({ plugin: 'mod-updates', key: 'updating' } as const, '')
const updated = atom({ plugin: 'mod-updates', key: 'updated' } as const, [] as string[])
const showAll = atom({ plugin: 'mod-updates', key: 'showAll' } as const, false)
const error = atom({ plugin: 'mod-updates', key: 'error' } as const, '')

let everyMs = 6 * 3_600_000
let timer: Timer | undefined
let bandOrder: Promise<string[]> | undefined
let lastAnnounced = ''

export const register: Register = (on, options) => {
  const hours = typeof options.everyHours === 'number' && options.everyHours >= 0 ? options.everyHours : 6
  everyMs = hours * 3_600_000
  bandOrder = undefined

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'mod-updates', description: 'New versions of your mods: what changed, and update in one click' }).catch(() => {})
    timer?.cancel()
    if (everyMs > 0) {
      $.clock.after(FIRST_CHECK_MS, () => void check($, true).catch(() => {}))
      timer = $.clock.every(everyMs, () => {
        void check($, true).catch(() => {})
      })
    }
    return r
  })

  on('command.run', { command: 'mod-updates' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Mod Updates', focus: true })
    void check($, true).catch(() => {})
    return { text: 'Mod Updates: checking your marketplaces…' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))

  // A line above the prompt only while there is something to do.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const list = await read($, rows)
    const done = await read($, updated)
    const waiting = list.filter(r => r.hasUpdate).length
    if (e.props.hasSurvey || (waiting === 0 && done.length === 0)) return rest
    const { Box, Text, Button } = $.ui.resolve(e)
    const mine = (
      <Box flexDirection="row" columnGap={1} alignItems="center" paddingX={1}>
        {waiting > 0 && <Text color="suggestion" weight="semibold">{`⬆ ${waiting} mod update${waiting === 1 ? '' : 's'}`}</Text>}
        {waiting > 0 && <Button key="review" label="Review" plain onPress={() => $.ui.open({ id: PANE, title: 'Mod Updates', focus: true })} />}
        {done.length > 0 && <Button key="reload" label={`↻ Reload to apply ${done.length}`} variant="primary" onPress={() => reload($)} />}
      </Box>
    )
    return stackBands(rest, NAME, mine, 'above', await (bandOrder ??= readBandOrder($).catch(() => [])))
  })
}

// ── Checking ──────────────────────────────────────────────────────────────

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

async function configDir($: EngineInterface): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  if (config) return slash(config)
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined)) ?? ''
  return `${slash(home)}/.claude`
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  const text = await $.fs.read(path).catch(() => '')
  try {
    return JSON.parse(typeof text === 'string' ? text : '')
  } catch {
    return null
  }
}

async function git($: EngineInterface, dir: string, args: string[], timeoutMs = 30_000) {
  const r = await $.process.run(['git', '-C', dir, ...args], { timeoutMs }).catch(() => null)
  return r && r.exitCode === 0 ? r.stdout : null
}

// The branch upstream: origin/HEAD, else origin/main, else origin/master.
async function upstream($: EngineInterface, dir: string): Promise<string | null> {
  const head = (await git($, dir, ['rev-parse', '--abbrev-ref', 'origin/HEAD']))?.trim()
  if (head && head !== 'origin/HEAD') return head
  for (const ref of ['origin/main', 'origin/master']) if ((await git($, dir, ['rev-parse', '--verify', '--quiet', ref])) !== null) return ref
  return null
}

async function check($: EngineInterface, isFetch: boolean) {
  if (await read($, checking)) return
  await update($, checking, () => true)
  await update($, error, () => '')
  try {
    const dir = await configDir($)
    const installed = readInstalled(await readJson($, `${dir}/plugins/installed_plugins.json`))
    const marketsJson = (await readJson($, `${dir}/plugins/known_marketplaces.json`)) as Record<string, { installLocation?: string }> | null
    const gitDirs = new Set<string>()
    for (const m of Object.values(marketsJson ?? {})) {
      const loc = m?.installLocation ? slash(m.installLocation) : ''
      if (loc && (await $.fs.exists(`${loc}/.git`).catch(() => false))) gitDirs.add(loc)
    }
    const markets = readMarkets(marketsJson, d => gitDirs.has(d))
    const out: Row[] = []
    for (const [market, source] of markets) {
      const mine = installed.filter(p => p.market === market)
      if (mine.length === 0) continue
      if (source.kind === 'git') {
        if (isFetch) await git($, source.dir, ['fetch', '--quiet', 'origin'], 90_000)
        const ref = await upstream($, source.dir)
        const catalog = ref ? readCatalog(safeJson(await git($, source.dir, ['show', `${ref}:.claude-plugin/marketplace.json`]))) : new Map()
        for (const p of mine) {
          const entry = catalog.get(p.name)
          if (!ref || !entry) {
            out.push({ id: p.id, name: p.name, market, from: p.version, to: p.version, commits: [], kind: 'git', hasUpdate: false, note: ref ? 'no longer listed in its marketplace' : 'could not read the marketplace' })
            continue
          }
          const manifest = safeJson(await git($, source.dir, ['show', `${ref}:${entry.path ? `${entry.path}/` : ''}.claude-plugin/plugin.json`])) as { version?: unknown } | null
          const to = entry.version || (typeof manifest?.version === 'string' ? manifest.version : '') || p.version
          const log = p.sha ? await git($, source.dir, ['log', `--max-count=${MAX_COMMITS}`, '--format=%h%x09%s', `${p.sha}..${ref}`, '--', entry.path || '.']) : null
          const commits = log ? parseLog(log) : []
          out.push({ id: p.id, name: p.name, market, from: p.version, to, commits, kind: 'git', hasUpdate: commits.length > 0 || isNewer(to, p.version), note: '' })
        }
      } else if (source.kind === 'folder') {
        const catalog = readCatalog(await readJson($, `${source.dir}/.claude-plugin/marketplace.json`))
        for (const p of mine) {
          const entry = catalog.get(p.name)
          const manifest = entry ? ((await readJson($, `${source.dir}/${entry.path ? `${entry.path}/` : ''}.claude-plugin/plugin.json`)) as { version?: unknown } | null) : null
          const to = (typeof manifest?.version === 'string' ? manifest.version : '') || entry?.version || p.version
          out.push({ id: p.id, name: p.name, market, from: p.version, to, commits: [], kind: 'folder', hasUpdate: to !== p.version, note: 'read live from its folder; Update records the new version' })
        }
      } else {
        for (const p of mine) out.push({ id: p.id, name: p.name, market, from: p.version, to: p.version, commits: [], kind: 'other', hasUpdate: false, note: 'not a git clone: Update asks the marketplace directly' })
      }
    }
    const sorted = sortRows(out)
    await update($, rows, () => sorted)
    await update($, checkedAt, () => Date.now())
    const waiting = sorted.filter(r => r.hasUpdate)
    const key = waiting.map(r => `${r.id}:${r.to}:${r.commits[0]?.sha ?? ''}`).join(',')
    if (waiting.length && key !== lastAnnounced) $.ui.toast(`${waiting.length} mod update${waiting.length === 1 ? '' : 's'}: ${waiting.slice(0, 3).map(r => r.name).join(', ')}. /mod-updates`)
    lastAnnounced = key
  } catch (err) {
    await update($, error, () => (err instanceof Error ? err.message : String(err)))
  } finally {
    await update($, checking, () => false)
  }
}

function safeJson(text: string | null): unknown {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

async function readBandOrder($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined))?.replace(/\\/g, '/')
  const file = bandsFile(await $.env.get('CLAUDE_CONFIG_DIR'), home)
  return file && (await $.fs.exists(file)) ? parseOrder(await $.fs.read(file)) : []
}

// ── Updating ──────────────────────────────────────────────────────────────

async function updateOne($: EngineInterface, id: string): Promise<boolean> {
  await update($, updating, () => id)
  const exe = (await $.env.get('CLAUDE_CODE_EXECPATH').catch(() => undefined)) || 'claude'
  const r = await $.process.run([exe, 'plugin', 'update', id], { timeoutMs: 180_000 }).catch(() => null)
  await update($, updating, () => '')
  if (!r || r.exitCode !== 0) {
    await update($, error, () => `Could not update ${id}: ${(r?.stderr || r?.stdout || 'claude did not run').trim().split(/\r?\n/).slice(-1)[0]}`)
    return false
  }
  await update($, updated, list => [...new Set([...list, id])])
  await update($, rows, list => list.map(x => (x.id === id ? { ...x, hasUpdate: false, from: x.to, commits: [] } : x)))
  return true
}

async function updateAll($: EngineInterface) {
  const waiting = (await read($, rows)).filter(r => r.hasUpdate)
  let ok = 0
  for (const r of waiting) if (await updateOne($, r.id)) ok++
  $.ui.toast(`Updated ${ok} of ${waiting.length}. Reload to apply`)
}

async function reload($: EngineInterface) {
  await $.command.run({ command: 'reload-plugins' }).catch(() => $.ui.toast('Run /reload-plugins to apply the updates'))
  await update($, updated, () => [])
}

// ── The pane ──────────────────────────────────────────────────────────────

export function ago(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`
}

async function drawPane($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const list = await read($, rows)
  const at = await read($, checkedAt)
  const isChecking = await read($, checking)
  const busyId = await read($, updating)
  const done = await read($, updated)
  const isAll = await read($, showAll)
  const problem = await read($, error)
  const now = Date.now()
  const waiting = list.filter(r => r.hasUpdate)
  const current = list.filter(r => !r.hasUpdate)
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
            <Text color="claude">{'⬆ '}</Text>
            {'Mod Updates'}
          </Text>
          <Text size="footnote" dimColor>
            {isChecking ? 'Checking your marketplaces…' : at ? `${waiting.length ? `${waiting.length} update${waiting.length === 1 ? '' : 's'}` : 'Everything is up to date'} · checked ${ago(at, now)}` : 'Not checked yet'}
          </Text>
        </Box>
        <Box flexDirection="row" columnGap={1} alignItems="center">
          {done.length > 0 && <Button key="reload" label={`↻ Reload to apply ${done.length}`} variant="primary" onPress={() => reload($)} />}
          {waiting.length > 1 && !busyId && <Button key="update-all" label={`⬆ Update all ${waiting.length}`} variant="primary" onPress={() => updateAll($)} />}
          <Button key="check" label={isChecking ? 'checking…' : '↻ Check now'} plain={isChecking ? true : undefined} onPress={() => check($, true)} />
          <Button key="close" label="✕" plain dimColor role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>

      {problem !== '' && (
        <Box borderStyle="round" borderColor="error" paddingX={1}>
          <Text color="error" wrap="wrap">
            {problem}
          </Text>
        </Box>
      )}

      {at > 0 && waiting.length === 0 && (
        <Box flexDirection="column" alignItems="center" borderStyle="round" borderColor="success" paddingY={1}>
          <Text color="success" weight="semibold">
            ✓ All {list.length} mods are on their latest version
          </Text>
        </Box>
      )}

      {waiting.map(r => (
        <Box key={`u-${r.id}`} flexDirection="column" borderStyle="round" borderColor="suggestion" hover={{ borderColor: 'claude' }} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1}>
            <Box flexDirection="row" columnGap={1} alignItems="center">
              <Text size="heading" weight="semibold">
                {r.name}
              </Text>
              <Text mono size="footnote" dimColor>{`v${r.from}`}</Text>
              <Text dimColor>→</Text>
              {pill(`to-${r.id}`, r.to === r.from ? `${r.commits.length} new commit${r.commits.length === 1 ? '' : 's'}` : `v${r.to}`, 'suggestion')}
            </Box>
            {busyId === r.id ? <Text color="suggestion">updating…</Text> : <Button key={`update-${r.id}`} label="⬆ Update" variant="primary" onPress={() => updateOne($, r.id)} />}
          </Box>
          <Text size="caption" dimColor>{`@${r.market}${r.note ? ` · ${r.note}` : ''}`}</Text>
          {r.commits.slice(0, 6).map(c => (
            <Text key={`c-${r.id}-${c.sha}`} size="footnote" wrap="truncate-end">
              <Text mono dimColor>{`${c.sha}  `}</Text>
              {c.subject}
            </Text>
          ))}
          {r.commits.length > 6 && <Text size="caption" dimColor>{`… and ${r.commits.length - 6} more`}</Text>}
        </Box>
      ))}

      {current.length > 0 && (
        <Box flexDirection="column">
          <Button key="show-all" label={isAll ? `▾ Up to date (${current.length})` : `▸ Up to date (${current.length})`} plain dimColor onPress={() => update($, showAll, v => !v)} />
          {isAll &&
            current.map(r => (
              <Text key={`ok-${r.id}`} size="footnote" dimColor wrap="truncate-end">
                {`  ${r.name}  v${r.from}  @${r.market}${r.note ? `  · ${r.note}` : ''}${done.includes(r.id) ? '  · updated, reload to apply' : ''}`}
              </Text>
            ))}
        </Box>
      )}
    </Box>
  )
}
