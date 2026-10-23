// What port-watch reads and how it names it. Pure: no $, so the tests call it directly.
import { qrcode } from './vendor/qrcode.mjs'

export type Listener = { address: string; port: number; pid: number }
export type Published = { container: string; containerPort: number; hostIp: string }
export type Served = { port: number; host: string; targetPort: number } // a Tailscale Serve mapping
export type Bind = 'local' | 'all' | 'tailnet' | 'other'
export type Kind = 'dev' | 'app' | 'system'
export type PortRow = {
  port: number
  pid: number
  process: string
  owner: string // the project, container or package it belongs to, as best as can be told
  kind: Kind // dev: a runtime, a container or a Serve proxy; app: a desktop program; system: Windows' own
  bind: Bind
  address: string
  url: string // where a browser reaches it from here
  phoneUrl: string // over Tailscale (its IP, or a Serve URL); '' when the phone cannot reach it
}

// Windows' own services and anything under 1024: never a dev server.
const SYSTEM = new Set(['system', 'system idle process', 'svchost.exe', 'lsass.exe', 'wininit.exe', 'services.exe', 'spoolsv.exe', 'smss.exe', 'csrss.exe', 'winlogon.exe', 'searchindexer.exe', 'mdnsresponder.exe', 'jhi_service.exe'])
// The processes a dev server runs as: language runtimes, web servers, container relays.
const RUNTIMES = /^(node|nodejs|bun|deno|python\d*(\.\d+)?|pythonw|py|uvicorn|gunicorn|hypercorn|java|javaw|dotnet|ruby|php|php-cgi|go|air|caddy|nginx|httpd|gvproxy|wslrelay|podman|docker-proxy|com\.docker\.backend|vpnkit|esbuild|vite|next-server|cargo|rust|code)(\.exe)?$/i

// `netstat -ano` LISTENING lines, IPv4 and IPv6.
export function parseNetstat(text: string): Listener[] {
  const out: Listener[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i)
    if (m) out.push({ address: m[1]!.replace(/^\[|\]$/g, ''), port: Number(m[2]), pid: Number(m[3]) })
  }
  return out
}

// `lsof -nP -iTCP -sTCP:LISTEN` (macOS, Linux): COMMAND PID ... NAME (addr:port) (LISTEN).
export function parseLsof(text: string): (Listener & { process: string })[] {
  const out: (Listener & { process: string })[] = []
  for (const line of text.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/)
    const name = cols.find(c => /:\d+$/.test(c))
    if (!name || cols.length < 2) continue
    const at = name.lastIndexOf(':')
    out.push({ process: cols[0]!, pid: Number(cols[1]), address: name.slice(0, at).replace(/^\[|\]$/g, '').replace(/^\*$/, '0.0.0.0'), port: Number(name.slice(at + 1)) })
  }
  return out
}

// `tasklist /fo csv /nh`: "name","pid",... as pid → name.
export function parseTasklist(csv: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const line of csv.split(/\r?\n/)) {
    const m = line.match(/^"([^"]*)","(\d+)"/)
    if (m) out.set(Number(m[2]), m[1]!)
  }
  return out
}

// `podman ps --format json` (or docker's, one object per line) as host port → its container.
export function parsePublished(text: string): Map<number, Published> {
  const out = new Map<number, Published>()
  let list: unknown[] = []
  try {
    const parsed = JSON.parse(text)
    list = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    list = text.split(/\r?\n/).filter(Boolean).flatMap(l => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
  }
  for (const c of list as { Names?: string[] | string; Ports?: unknown }[]) {
    const name = Array.isArray(c.Names) ? (c.Names[0] ?? '') : String(c.Names ?? '')
    for (const p of (Array.isArray(c.Ports) ? c.Ports : []) as { host_port?: number; container_port?: number; host_ip?: string; range?: number }[]) {
      if (!p.host_port) continue
      for (let i = 0; i < Math.max(1, p.range ?? 1); i++) out.set(p.host_port + i, { container: name, containerPort: (p.container_port ?? 0) + i, hostIp: p.host_ip ?? '' })
    }
  }
  return out
}

// `tailscale serve status --json`: each tailnet port and the local port it proxies to.
export function parseServe(text: string): Served[] {
  let s: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }
  try {
    s = JSON.parse(text)
  } catch {
    return []
  }
  const out: Served[] = []
  for (const [hostPort, web] of Object.entries(s?.Web ?? {})) {
    const at = hostPort.lastIndexOf(':')
    const proxy = Object.values(web?.Handlers ?? {}).find(h => typeof h?.Proxy === 'string')?.Proxy ?? ''
    const target = Number(proxy.match(/:(\d+)(?:\/|$)/)?.[1] ?? 0)
    if (at > 0 && target) out.push({ host: hostPort.slice(0, at), port: Number(hostPort.slice(at + 1)), targetPort: target })
  }
  return out
}

// A process's project from its command line: a projects/<name> folder, an npx package, the app a
// node_modules tool runs for, a Python module, else its script's folder.
export function ownerOf(commandLine: string, process: string): string {
  const cl = commandLine.replace(/\\\\/g, '\\')
  const project = cl.match(/[\\/]projects[\\/]([^\\/"'\s]+)/i)?.[1]
  if (project) return project
  const npx = cl.match(/npx-cli\.js"?\s+(?:-y\s+)?(@?[\w.-]+(?:\/[\w.-]+)?)/i)?.[1]
  if (npx) return npx.replace(/@[\d.]+$/, '')
  const app = cl.match(/([\w.-]+)[\\/]node_modules[\\/]/i)?.[1] // the app whose dependency runs it (vite, next…)
  if (app) return app
  const module = cl.match(/\s-m\s+([\w]+)/)?.[1]
  if (module) return module
  const script = cl.match(/([\w.-]+)[\\/][^\\/"'\s]+\.(?:m?js|ts|py)\b/i)?.[1]
  if (script && !/^(bin|dist|src|scripts|node_modules)$/i.test(script)) return script
  return process.replace(/\.exe$/i, '')
}

export function bindOf(address: string, tailnetIp: string): Bind {
  if (address === '127.0.0.1' || address === '::1' || address === 'localhost') return 'local'
  if (address === '0.0.0.0' || address === '::' || address === '*') return 'all'
  if (tailnetIp && address === tailnetIp) return 'tailnet'
  return 'other'
}

// One row per port (IPv4 and IPv6 listeners merged, the widest bind kept), sorted by port:
// container ports netstat cannot see are added, and Tailscale Serve ports named by what they serve.
export function rows(args: {
  listeners: (Listener & { process?: string })[]
  names: Map<number, string>
  commandLines: Map<number, string>
  published: Map<number, Published>
  served?: Served[]
  tailnetIp: string
}): PortRow[] {
  const rank: Record<Bind, number> = { all: 3, tailnet: 2, other: 1, local: 0 }
  const served = args.served ?? []
  const byPort = new Map<number, PortRow>()
  const put = (row: PortRow) => {
    const had = byPort.get(row.port)
    if (!had || rank[row.bind] > rank[had.bind]) byPort.set(row.port, had ? { ...row, owner: had.owner.startsWith('pid ') ? row.owner : had.owner } : row)
  }
  for (const l of args.listeners) {
    const process = l.process ?? args.names.get(l.pid) ?? `pid ${l.pid}`
    const pub = args.published.get(l.port)
    const bind = pub && pub.hostIp && pub.hostIp !== '0.0.0.0' ? bindOf(pub.hostIp, args.tailnetIp) : bindOf(l.address, args.tailnetIp)
    const owner = pub ? `${pub.container} (container :${pub.containerPort})` : ownerOf(args.commandLines.get(l.pid) ?? '', process)
    const isSystem = !pub && (l.pid <= 4 || SYSTEM.has(process.toLowerCase()) || l.port < 1024)
    const kind: Kind = isSystem ? 'system' : pub || RUNTIMES.test(process) || /[\\/]projects[\\/]/i.test(args.commandLines.get(l.pid) ?? '') ? 'dev' : 'app'
    put({
      port: l.port,
      pid: l.pid,
      process,
      owner,
      kind,
      bind,
      address: l.address,
      url: `http://127.0.0.1:${l.port}/`,
      phoneUrl: args.tailnetIp && (bind === 'all' || bind === 'tailnet') ? `http://${args.tailnetIp}:${l.port}/` : '',
    })
  }
  // Published container ports the host's netstat does not list (podman relays them from its VM).
  for (const [port, pub] of args.published) {
    if (byPort.has(port)) continue
    const bind = bindOf(pub.hostIp || '0.0.0.0', args.tailnetIp)
    put({ port, pid: 0, process: 'container', owner: `${pub.container} (container :${pub.containerPort})`, kind: 'dev', bind, address: pub.hostIp || '0.0.0.0', url: `http://127.0.0.1:${port}/`, phoneUrl: args.tailnetIp && bind !== 'local' ? `http://${args.tailnetIp}:${port}/` : '' })
  }
  // Tailscale Serve: the tailnet port says what it serves; the local server gets the Serve URL.
  for (const s of served) {
    const url = `https://${s.host}${s.port === 443 ? '' : `:${s.port}`}/`
    const target = byPort.get(s.targetPort)
    const proxy = byPort.get(s.port)
    if (proxy) byPort.set(s.port, { ...proxy, kind: 'dev', owner: `serve → :${s.targetPort}${target ? ` ${target.owner}` : ''}`, phoneUrl: url })
    if (target && !target.phoneUrl) byPort.set(s.targetPort, { ...target, kind: target.kind === 'system' ? 'system' : 'dev', phoneUrl: url })
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port)
}

// A QR code for `text` as an SVG document: one path of dark modules, a quiet zone of 4.
export function qrSvg(text: string, size = 220): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const cells = n + 8
  let d = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${cells} ${cells}" shape-rendering="crispEdges"><rect width="${cells}" height="${cells}" fill="#ffffff"/><path d="${d}" fill="#111111"/></svg>`
}
