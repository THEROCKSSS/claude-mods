// Port Watch: what is listening here, who owns it, and how to reach it from your phone.
//   - Windows: netstat -ano, tasklist and each listener's command line (one CIM query); macOS and
//     Linux: lsof and ps. podman's (or docker's) published ports are named by their container.
//   - The Tailscale IP turns a port bound to every interface into a URL your phone can open,
//     shown as text and as a QR code to scan. A port bound to 127.0.0.1 says why it cannot.
//   - /ports opens the pane; it scans again every 20 s while it is open.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PortRow } from '../types'
import { parseLsof, parseNetstat, parsePublished, parseServe, parseTasklist, qrSvg, rows as toRows, type Served } from './ports'

const PANE = 'port-watch'
const PER_PAGE = 12
const RESCAN_MS = 20_000
const TAILSCALE_WINDOWS = 'C:/Program Files/Tailscale/tailscale.exe'

const rows = atom({ plugin: 'port-watch', key: 'rows' } as const, [] as PortRow[])
const scannedAt = atom({ plugin: 'port-watch', key: 'scannedAt' } as const, 0)
const scanning = atom({ plugin: 'port-watch', key: 'scanning' } as const, false)
const filter = atom({ plugin: 'port-watch', key: 'filter' } as const, 'dev' as 'dev' | 'phone' | 'all')
const query = atom({ plugin: 'port-watch', key: 'query' } as const, '')
const qr = atom({ plugin: 'port-watch', key: 'qr' } as const, 0)
const page = atom({ plugin: 'port-watch', key: 'page' } as const, 0)
const tailnetIp = atom({ plugin: 'port-watch', key: 'tailnetIp' } as const, '')
const error = atom({ plugin: 'port-watch', key: 'error' } as const, '')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'ports', description: 'What is listening on this machine, who owns it, and a QR code to open it on your phone' }).catch(() => {})
    $.clock.every(RESCAN_MS, () => {
      void (async () => {
        if ((await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)) await scan($)
      })().catch(() => {})
    })
    return r
  })

  on('command.run', { command: 'ports' }, async ($, e) => {
    const arg = e.args.trim()
    if (/^\d+$/.test(arg)) await update($, qr, () => Number(arg))
    await $.ui.open({ id: PANE, title: 'Ports', focus: true })
    await scan($)
    const list = await read($, rows)
    return { text: `Ports: ${list.filter(r => r.kind === 'dev').length} dev servers listening, ${list.filter(r => r.kind === 'dev' && r.phoneUrl).length} reachable from your phone.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))
}

// ── Scanning ──────────────────────────────────────────────────────────────

const slash = (p: string) => p.replace(/\\/g, '/')

async function run($: EngineInterface, argv: string[], timeoutMs = 20_000) {
  const r = await $.process.run(argv, { timeoutMs }).catch(() => null)
  return r && r.exitCode === 0 ? r.stdout : ''
}

// The Tailscale IP and what Tailscale Serve proxies, from whichever tailscale binary answers.
async function findTailnet($: EngineInterface, isWindows: boolean): Promise<{ ip: string; served: Served[] }> {
  for (const exe of isWindows ? [TAILSCALE_WINDOWS, 'tailscale'] : ['tailscale']) {
    if (isWindows && exe === TAILSCALE_WINDOWS && !(await $.fs.exists(exe).catch(() => false))) continue
    const ip = (await run($, [exe, 'ip', '-4'], 8_000)).trim().split(/\r?\n/)[0] ?? ''
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return { ip, served: parseServe(await run($, [exe, 'serve', 'status', '--json'], 8_000)) }
  }
  return { ip: '', served: [] }
}

async function scan($: EngineInterface) {
  if (await read($, scanning)) return
  await update($, scanning, () => true)
  try {
    const isWindows = /^[A-Za-z]:\//.test(slash($.plugin.root))
    const { ip, served } = await findTailnet($, isWindows)
    let published = new Map()
    for (const runtime of ['podman', 'docker']) {
      const out = await run($, [runtime, 'ps', '--format', 'json'])
      if (out.trim()) {
        published = parsePublished(out)
        break
      }
    }
    let next: PortRow[]
    if (isWindows) {
      const listeners = parseNetstat(await run($, ['netstat', '-ano', '-p', 'TCP'])).concat(parseNetstat(await run($, ['netstat', '-ano', '-p', 'TCPv6'])))
      const names = parseTasklist(await run($, ['tasklist', '/fo', 'csv', '/nh']))
      const pids = [...new Set(listeners.map(l => l.pid).filter(p => p > 4))]
      const commandLines = new Map<number, string>()
      if (pids.length) {
        const filterText = pids.map(p => `ProcessId=${p}`).join(' OR ')
        const json = await run($, ['powershell', '-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "${filterText}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`], 30_000)
        try {
          const parsed = JSON.parse(json || '[]')
          for (const p of (Array.isArray(parsed) ? parsed : [parsed]) as { ProcessId?: number; CommandLine?: string }[]) if (p.ProcessId) commandLines.set(p.ProcessId, p.CommandLine ?? '')
        } catch {}
      }
      next = toRows({ listeners, names, commandLines, published, served, tailnetIp: ip })
    } else {
      const listeners = parseLsof(await run($, ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN']))
      const commandLines = new Map<number, string>()
      const pids = [...new Set(listeners.map(l => l.pid))]
      if (pids.length) {
        for (const line of (await run($, ['ps', '-o', 'pid=,command=', '-p', pids.join(',')])).split(/\r?\n/)) {
          const m = line.trim().match(/^(\d+)\s+(.*)$/)
          if (m) commandLines.set(Number(m[1]), m[2]!)
        }
      }
      next = toRows({ listeners, names: new Map(), commandLines, published, served, tailnetIp: ip })
    }
    await update($, rows, () => next)
    await update($, tailnetIp, () => ip)
    await update($, scannedAt, () => Date.now())
    await update($, error, () => (next.length ? '' : 'Nothing listening was found (or the scan tools did not run).'))
  } finally {
    await update($, scanning, () => false)
  }
}

// ── Doing ─────────────────────────────────────────────────────────────────

async function openUrl($: EngineInterface, url: string) {
  const isWindows = /^[A-Za-z]:\//.test(slash($.plugin.root))
  const uname = isWindows ? '' : (await run($, ['uname', '-s'], 3_000)).trim()
  await $.process.run(isWindows ? ['explorer.exe', url] : [uname === 'Darwin' ? 'open' : 'xdg-open', url], { timeoutMs: 10_000 }).catch(() => null)
}

async function copy($: EngineInterface, text: string) {
  const viaSurface = await $.ui.copy({ text }).catch(() => ({ isCopied: false }))
  const isWindows = /^[A-Za-z]:\//.test(slash($.plugin.root))
  const ok = viaSurface.isCopied || (await $.process.run(isWindows ? ['clip'] : ['pbcopy'], { stdin: text, timeoutMs: 5_000 }).catch(() => null))?.exitCode === 0
  $.ui.toast(ok ? `Copied ${text}` : `Copy it by hand: ${text}`)
}

// ── The pane ──────────────────────────────────────────────────────────────

export function shown(list: PortRow[], f: 'dev' | 'phone' | 'all', q: string): PortRow[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  return list.filter(r => (f === 'all' || r.kind === 'dev') && (f !== 'phone' || r.phoneUrl !== '') && words.every(w => `${r.port} ${r.owner} ${r.process}`.toLowerCase().includes(w)))
}

async function drawPane($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const Input = 'Input' in elements ? elements.Input : undefined
  const Svg = 'Svg' in elements ? elements.Svg : undefined
  const list = await read($, rows)
  const f = await read($, filter)
  const q = await read($, query)
  const open = await read($, qr)
  const at = await read($, page)
  const ip = await read($, tailnetIp)
  const when = await read($, scannedAt)
  const isScanning = await read($, scanning)
  const problem = await read($, error)
  const visible = shown(list, f, q)
  const pages = Math.max(1, Math.ceil(visible.length / PER_PAGE))
  const p = Math.min(at, pages - 1)
  const dev = list.filter(r => r.kind === 'dev').length
  const phone = list.filter(r => r.kind === 'dev' && r.phoneUrl).length
  const pill = (key: string, text: string, bg: string) => (
    <Text key={key} backgroundColor={bg} color="inverseText" weight="semibold" size="caption">
      {` ${text} `}
    </Text>
  )
  const chip = (value: 'dev' | 'phone' | 'all', label: string) => (
    <Button
      key={`f-${value}`}
      label={label}
      variant={f === value ? 'primary' : undefined}
      plain={f === value ? undefined : true}
      dimColor={f !== value}
      onPress={async () => {
        await update($, filter, () => value)
        await update($, page, () => 0)
      }}
    />
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2} flexWrap="wrap">
        <Box flexDirection="column">
          <Text size="title" weight="bold">
            <Text color="claude">{'⇄ '}</Text>
            {'Ports'}
          </Text>
          <Text size="footnote" dimColor>
            {`${dev} dev servers · ${phone} reachable from your phone${ip ? ` over Tailscale (${ip})` : ' · Tailscale not found'}`}
          </Text>
        </Box>
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Button key="scan" label={isScanning ? 'scanning…' : '↻ Scan'} plain={isScanning ? true : undefined} onPress={() => scan($)} />
          <Button key="close" label="✕" plain dimColor role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1} gap={1}>
        {Input && (
          <Input
            key="search"
            placeholder="Search port, project or process…"
            value={q}
            submitLabel="search"
            onInput={async v => {
              await update($, query, () => v)
              await update($, page, () => 0)
            }}
            onSubmit={v => update($, query, () => v)}
          />
        )}
        <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
          {chip('dev', `Dev servers ${dev}`)}
          {chip('phone', `Phone ok ${phone}`)}
          {chip('all', `All ${list.length}`)}
          <Text size="caption" dimColor>{when ? `scanned ${Math.round((Date.now() - when) / 1000)} s ago` : ''}</Text>
        </Box>
      </Box>

      {problem !== '' && <Text color="warning">{problem}</Text>}
      {list.length > 0 && visible.length === 0 && <Text dimColor>Nothing matches. Try All, or another word.</Text>}

      {visible.slice(p * PER_PAGE, (p + 1) * PER_PAGE).map(r => {
        const isOpen = open === r.port
        return (
          <Box key={`port-${r.port}`} flexDirection="column" borderStyle="round" borderColor={isOpen ? 'claude' : r.phoneUrl ? 'success' : 'inactive'} borderDimColor={!isOpen && !r.phoneUrl} hover={{ borderColor: 'claude', borderDimColor: false }} paddingX={1}>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1} flexWrap="wrap">
              <Text wrap="truncate-end">
                <Text size="heading" weight="bold" mono>{`:${r.port}`}</Text>
                <Text weight="semibold">{`  ${r.owner}`}</Text>
                <Text size="footnote" dimColor>{`  ${r.process} · pid ${r.pid}`}</Text>
              </Text>
              {r.phoneUrl ? pill(`b-${r.port}`, 'PHONE OK', 'success') : r.bind === 'local' ? pill(`b-${r.port}`, 'THIS PC ONLY', 'inactive') : pill(`b-${r.port}`, r.bind.toUpperCase(), 'inactive')}
            </Box>
            <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
              <Text mono size="footnote" dimColor={!r.phoneUrl}>
                {r.phoneUrl || r.url}
              </Text>
              <Button key={`open-${r.port}`} label="Open ↗" plain onPress={() => openUrl($, r.url)} />
              <Button key={`copy-${r.port}`} label="⧉ Copy" plain dimColor onPress={() => copy($, r.phoneUrl || r.url)} />
              {r.phoneUrl !== '' && <Button key={`qr-${r.port}`} label={isOpen ? '▣ Hide QR' : '▣ QR'} variant={isOpen ? 'primary' : undefined} plain={isOpen ? undefined : true} onPress={() => update($, qr, v => (v === r.port ? 0 : r.port))} />}
            </Box>
            {isOpen && r.phoneUrl !== '' && (
              <Box flexDirection="row" columnGap={2} alignItems="center">
                {Svg ? <Svg key={`qr-svg-${r.port}`} source={qrSvg(r.phoneUrl)} alt={`QR code for ${r.phoneUrl}`} width={220} height={220} /> : <Text dimColor>This surface draws no pictures.</Text>}
                <Text size="footnote" dimColor wrap="wrap">
                  {`Scan with your phone's camera while it is on Tailscale.\n${r.phoneUrl}`}
                </Text>
              </Box>
            )}
            {!r.phoneUrl && r.bind === 'local' && r.kind === 'dev' && (
              <Text size="caption" dimColor>
                Bound to 127.0.0.1, so only this PC reaches it. Start it on 0.0.0.0, or `tailscale serve` it, to open it from your phone.
              </Text>
            )}
          </Box>
        )
      })}

      {pages > 1 && (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Button key="prev" label="‹ Prev" plain dimColor={p === 0} onPress={() => update($, page, n => Math.max(0, n - 1))} />
          <Text size="footnote" dimColor>{`${p + 1} of ${pages}`}</Text>
          <Button key="next" label="Next ›" plain dimColor={p >= pages - 1} onPress={() => update($, page, n => Math.min(pages - 1, n + 1))} />
        </Box>
      )}
    </Box>
  )
}
