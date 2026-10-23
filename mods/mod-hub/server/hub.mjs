// Mod Hub server: serves the web app and passes messages between it and the mod.
//   (mod-logic POSTs /api/graph too: its reading of every mod, for the 2D/3D #/logic view.)
//   node hub.mjs --dir <~/.claude/mod-hub> --app <plugin>/app [--port 8796]
// It never runs anything itself. The mod POSTs its state here and polls for the
// actions the page queued; the page reads the state over SSE and queues actions.
// Every /api call but /api/ping needs the token (written to <dir>/server.json, and
// put in the page it serves), a Host of 127.0.0.1 or localhost on this port, and no
// foreign Origin, so another website or a DNS-rebinding page cannot drive it.
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_BODY = 1_000_000
const MAX_ACTIONS = 200
// Bumped whenever the API changes. The mod compares it with its own and replaces an older hub
// left running from before an update, which would otherwise keep serving the old API.
export const SERVER_VERSION = 3
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' }

export function parseArgs(argv) {
  const out = { port: 8796, dir: '', app: '' }
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]]
    if (k === '--port') (out.port = Number(v)), i++
    else if (k === '--dir') (out.dir = v), i++
    else if (k === '--app') (out.app = v), i++
  }
  return out
}

// One action the page may queue, or null. Only these shapes reach the mod, which checks them again.
export function cleanAction(a) {
  if (!a || typeof a !== 'object') return null
  if (a.type === 'run' && typeof a.command === 'string' && /^[\w:.-]{1,64}$/.test(a.command)) {
    return { type: 'run', command: a.command, args: typeof a.args === 'string' ? a.args.slice(0, 500) : '' }
  }
  if (a.type === 'toggle' && typeof a.id === 'string' && /^[\w.:@-]{1,200}$/.test(a.id) && typeof a.on === 'boolean') return { type: 'toggle', id: a.id, on: a.on }
  if (a.type === 'reload') return { type: 'reload' }
  // Presets: the mod checks a saved preset's every field again (shared/presets.ts cleanPreset).
  if (a.type === 'preset-save' && a.preset && typeof a.preset === 'object' && JSON.stringify(a.preset).length <= 20_000) return { type: 'preset-save', preset: a.preset }
  if ((a.type === 'preset-delete' || a.type === 'preset-apply') && typeof a.id === 'string' && /^[\w-]{1,60}$/.test(a.id)) return { type: a.type, id: a.id }
  if (a.type === 'preset-snapshot' && typeof a.name === 'string' && a.name.trim() && a.name.length <= 60) return { type: 'preset-snapshot', name: a.name.trim() }
  if (a.type === 'pins' && Array.isArray(a.pins) && a.pins.length <= 12 && a.pins.every(p => typeof p === 'string' && /^[\w:.-]{1,64}$/.test(p))) return { type: 'pins', pins: a.pins }
  return null
}

export function startHub({ port, dir, app, token = randomBytes(24).toString('hex'), writeInfo = true, onShutdown = undefined }) {
  const appRoot = resolve(app)
  let state = null
  let stateAt = 0
  let graph = null // mod-logic's reading of every mod, for the #/logic view
  let graphAt = 0
  let mission = null // mission-control-win's live tree and code map, for the #/mission view
  let seq = 0
  const actions = []
  const listeners = new Set()
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])

  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  const broadcast = () => {
    const data = `data: ${JSON.stringify({ state, stateAt, graph, graphAt, mission })}\n\n`
    for (const res of listeners) res.write(data)
  }
  const readBody = req =>
    new Promise((ok, fail) => {
      let size = 0
      const chunks = []
      req.on('data', c => {
        size += c.length
        if (size > MAX_BODY) {
          fail(new Error('too large'))
          req.destroy()
        } else chunks.push(c)
      })
      req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')))
      req.on('error', fail)
    })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    // A page served from any other name (DNS rebinding) or posted from another site gets nothing.
    if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 421, { error: 'wrong host' })
    const origin = req.headers.origin
    if (origin && !allowedOrigins.has(origin)) return send(res, 403, { error: 'foreign origin' })

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/ping') return send(res, 200, { ok: true, app: 'mod-hub', pid: process.pid, version: SERVER_VERSION })
      if (url.pathname === '/api/shutdown' && req.method === 'POST' && (req.headers['x-mod-hub-token'] ?? '') === token) {
        send(res, 200, { ok: true, stopping: true })
        setTimeout(() => (onShutdown ? onShutdown() : process.exit(0)), 50) // after the answer is out
        return
      }
      const given = req.headers['x-mod-hub-token'] ?? url.searchParams.get('token')
      if (given !== token) return send(res, 401, { error: 'token' })

      if (url.pathname === '/api/state' && req.method === 'POST') {
        try {
          state = JSON.parse(await readBody(req))
          stateAt = Date.now()
          broadcast()
          return send(res, 200, { ok: true })
        } catch {
          return send(res, 400, { error: 'bad state' })
        }
      }
      if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, { state, stateAt })
      if (url.pathname === '/api/graph' && req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody(req))
          if (!body || !Array.isArray(body.mods)) return send(res, 400, { error: 'bad graph' })
          graph = { mods: body.mods, changed: body.changed ?? null }
          graphAt = Date.now()
          broadcast()
          return send(res, 200, { ok: true })
        } catch {
          return send(res, 400, { error: 'bad graph' })
        }
      }
      if (url.pathname === '/api/graph' && req.method === 'GET') return send(res, 200, { graph, graphAt })
      if (url.pathname === '/api/mission' && req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody(req))
          if (!body || !Array.isArray(body.lines) || typeof body.svg !== 'string' || !body.svg.startsWith('<svg')) return send(res, 400, { error: 'bad mission' })
          mission = body
          broadcast()
          return send(res, 200, { ok: true })
        } catch {
          return send(res, 400, { error: 'bad mission' })
        }
      }
      if (url.pathname === '/api/mission' && req.method === 'GET') return send(res, 200, { mission })
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write(`data: ${JSON.stringify({ state, stateAt, graph, graphAt, mission })}\n\n`)
        listeners.add(res)
        const beat = setInterval(() => res.write(': beat\n\n'), 15_000)
        req.on('close', () => {
          clearInterval(beat)
          listeners.delete(res)
        })
        return
      }
      if (url.pathname === '/api/actions' && req.method === 'POST') {
        let a
        try {
          a = cleanAction(JSON.parse(await readBody(req)))
        } catch {
          a = null
        }
        if (!a) return send(res, 400, { error: 'not an action' })
        actions.push({ seq: ++seq, at: Date.now(), ...a })
        if (actions.length > MAX_ACTIONS) actions.splice(0, actions.length - MAX_ACTIONS)
        return send(res, 200, { ok: true, seq })
      }
      if (url.pathname === '/api/actions' && req.method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? 0) || 0
        return send(res, 200, { actions: actions.filter(a => a.seq > after) })
      }
      return send(res, 404, { error: 'no such api' })
    }

    if (req.method !== 'GET') return send(res, 405, { error: 'GET only' })
    // The app's files, never anything outside its folder.
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const file = normalize(join(appRoot, rel))
    if (!file.startsWith(appRoot + sep) && file !== appRoot) return send(res, 403, { error: 'outside the app' })
    // Routes are hash routes, so only / is the page. A missing file is a 404, never the page: a tab
    // left open across an update asks for old chunks, and must fail as a load error it can report.
    const target = file
    if (!existsSync(target) || !statSync(target).isFile()) {
      return rel === 'index.html'
        ? send(res, 404, 'The Mod Hub app is not built. Run npm run build in mods/mod-hub/web.', 'text/plain; charset=utf-8')
        : send(res, 404, 'not found', 'text/plain; charset=utf-8')
    }
    let body = readFileSync(target)
    if (target.endsWith('index.html')) body = Buffer.from(body.toString('utf8').replace('__MOD_HUB_TOKEN__', token))
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      'cache-control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    })
    res.end(body)
  })

  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(port, '127.0.0.1', () => {
      if (writeInfo && dir) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'server.json'), JSON.stringify({ port, host: '127.0.0.1', token, pid: process.pid, version: SERVER_VERSION, startedAt: new Date().toISOString() }, null, 2))
      }
      ok({ server, token, close: () => new Promise(done => { for (const r of listeners) r.end(); server.close(() => done()) }) })
    })
  })
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.dir || !args.app) {
    console.error('usage: node hub.mjs --dir <state dir> --app <app dir> [--port 8796]')
    process.exit(2)
  }
  // A hub that stops says why in <dir>/hub.log: its start, its exit code, a signal, or the crash.
  const log = line => {
    try {
      mkdirSync(args.dir, { recursive: true })
      appendFileSync(join(args.dir, 'hub.log'), `${new Date().toISOString()} pid ${process.pid} ${line}\n`)
    } catch {}
  }
  log(`start v${SERVER_VERSION} port ${args.port}`)
  process.on('exit', code => log(`exit ${code}`))
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, () => (log(`signal ${signal}`), process.exit(0)))
  process.on('uncaughtException', err => {
    log(`crash ${err?.stack ?? err}`)
    process.exit(1)
  })
  startHub(args).catch(err => {
    log(`could not start: ${err.code ?? err.message}`)
    console.error(`mod-hub: ${err.code === 'EADDRINUSE' ? `port ${args.port} is in use` : err.message}`)
    process.exit(1)
  })
}
