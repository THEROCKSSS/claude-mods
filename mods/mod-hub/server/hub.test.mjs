// node --test server/hub.test.mjs. Uses node:http, not fetch: fetch rewrites the Host header,
// so a host check tested with it passes while the check is broken.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { cleanAction, SERVER_VERSION, startHub } from './hub.mjs'

const PORT = 18796
let hub, dir
let stopped = 0

function call(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method, headers: { host: `127.0.0.1:${PORT}`, ...headers } }, res => {
      let text = ''
      res.on('data', c => (text += c))
      res.on('end', () => ok({ status: res.statusCode, text, json: () => JSON.parse(text) }))
    })
    req.on('error', fail)
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mod-hub-'))
  const app = join(dir, 'app')
  mkdirSync(app)
  writeFileSync(join(app, 'index.html'), '<meta name="mod-hub-token" content="__MOD_HUB_TOKEN__">hub')
  writeFileSync(join(dir, 'secret.txt'), 'outside')
  hub = await startHub({ port: PORT, dir, app, onShutdown: () => stopped++ })
})
after(() => hub.close())

test('writes server.json with the token and pid', () => {
  const info = JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8'))
  assert.equal(info.port, PORT)
  assert.equal(info.token, hub.token)
  assert.equal(info.pid, process.pid)
})

test('the page carries the token; nothing outside the app is served', async () => {
  const page = await call('/')
  assert.equal(page.status, 200)
  assert.match(page.text, new RegExp(hub.token))
  const escape = await call('/..%2fsecret.txt')
  assert.notEqual(escape.text, 'outside')
  const gone = await call('/assets/Old-chunk.js') // a tab from before an update asking for a chunk that is gone
  assert.equal(gone.status, 404)
  assert.doesNotMatch(gone.text, /mod-hub-token/)
})

test('ping needs no token; every other api does', async () => {
  assert.equal((await call('/api/ping')).status, 200)
  assert.equal((await call('/api/state')).status, 401)
  assert.equal((await call('/api/state', { headers: { 'x-mod-hub-token': 'wrong' } })).status, 401)
  assert.equal((await call('/api/state', { headers: { 'x-mod-hub-token': hub.token } })).status, 200)
})

test('a foreign Host (DNS rebinding) or Origin is refused, even with the token', async () => {
  const t = { 'x-mod-hub-token': hub.token }
  assert.equal((await call('/api/state', { headers: { ...t, host: 'evil.example:18796' } })).status, 421)
  assert.equal((await call('/api/actions', { method: 'POST', headers: { ...t, origin: 'https://evil.example' }, body: { type: 'reload' } })).status, 403)
  assert.equal((await call('/api/actions', { method: 'POST', headers: { ...t, origin: `http://127.0.0.1:${PORT}` }, body: { type: 'reload' } })).status, 200)
})

test('state goes in and out; actions queue in order and only valid shapes', async () => {
  const t = { 'x-mod-hub-token': hub.token, 'content-type': 'application/json' }
  assert.equal((await call('/api/state', { method: 'POST', headers: t, body: { mods: [{ id: 'a@b' }] } })).status, 200)
  assert.deepEqual((await call('/api/state', { headers: t })).json().state, { mods: [{ id: 'a@b' }] })
  const before = (await call('/api/actions?after=0', { headers: t })).json().actions.length
  assert.equal((await call('/api/actions', { method: 'POST', headers: t, body: { type: 'run', command: 'mission', args: 'code' } })).status, 200)
  assert.equal((await call('/api/actions', { method: 'POST', headers: t, body: { type: 'run', command: 'rm -rf /' } })).status, 400)
  assert.equal((await call('/api/actions', { method: 'POST', headers: t, body: { type: 'shell', cmd: 'x' } })).status, 400)
  const list = (await call('/api/actions?after=0', { headers: t })).json().actions
  assert.equal(list.length, before + 1)
  assert.deepEqual({ ...list.at(-1), seq: 0, at: 0 }, { seq: 0, at: 0, type: 'run', command: 'mission', args: 'code' })
  const last = list.at(-1).seq
  assert.deepEqual((await call(`/api/actions?after=${last}`, { headers: t })).json().actions, [])
})

test('the logic graph goes in and out, and needs the token', async () => {
  const t = { 'x-mod-hub-token': hub.token, 'content-type': 'application/json' }
  assert.equal((await call('/api/graph', { method: 'POST', body: { mods: [] } })).status, 401)
  assert.equal((await call('/api/graph', { method: 'POST', headers: t, body: { nope: 1 } })).status, 400)
  assert.equal((await call('/api/graph', { method: 'POST', headers: t, body: { mods: [{ id: 'a@b', hooks: [] }], changed: { mod: 'a@b', file: 'x', at: 1 } } })).status, 200)
  assert.deepEqual((await call('/api/graph', { headers: t })).json().graph, { mods: [{ id: 'a@b', hooks: [] }], changed: { mod: 'a@b', file: 'x', at: 1 } })
})

test('the mission feed goes in and out, needs the token, and must be an svg', async () => {
  const t = { 'x-mod-hub-token': hub.token, 'content-type': 'application/json' }
  const body = { at: 1, turn: 2, summary: { agents: 0, running: 0, tools: 1, failed: 0 }, lines: [{ prefix: '◆ ', text: 'main' }], files: [], svg: '<svg></svg>' }
  assert.equal((await call('/api/mission', { method: 'POST', body })).status, 401)
  assert.equal((await call('/api/mission', { method: 'POST', headers: t, body: { ...body, svg: '<script>' } })).status, 400)
  assert.equal((await call('/api/mission', { method: 'POST', headers: t, body })).status, 200)
  assert.equal((await call('/api/mission', { headers: t })).json().mission.turn, 2)
})

test('ping says the server version; shutdown needs the token', async () => {
  const ping = (await call('/api/ping')).json()
  assert.equal(ping.version, SERVER_VERSION)
  assert.equal((await call('/api/shutdown', { method: 'POST' })).status, 401)
  assert.equal(stopped, 0)
  assert.equal((await call('/api/shutdown', { method: 'POST', headers: { 'x-mod-hub-token': hub.token } })).status, 200)
  await new Promise(done => setTimeout(done, 80))
  assert.equal(stopped, 1)
})

test('cleanAction keeps the preset actions, within bounds', () => {
  assert.deepEqual(cleanAction({ type: 'preset-apply', id: 'focus-2' }), { type: 'preset-apply', id: 'focus-2' })
  assert.equal(cleanAction({ type: 'preset-apply', id: '../x' }), null)
  assert.deepEqual(cleanAction({ type: 'preset-snapshot', name: '  Streaming ' }), { type: 'preset-snapshot', name: 'Streaming' })
  assert.equal(cleanAction({ type: 'preset-snapshot', name: '' }), null)
  assert.equal(cleanAction({ type: 'preset-save', preset: { name: 'x'.repeat(30_000) } }), null)
  assert.deepEqual(cleanAction({ type: 'preset-save', preset: { name: 'Focus' } }), { type: 'preset-save', preset: { name: 'Focus' } })
})

test('cleanAction keeps only the four shapes', () => {
  assert.deepEqual(cleanAction({ type: 'toggle', id: 'snake@claude-code-mods', on: false }), { type: 'toggle', id: 'snake@claude-code-mods', on: false })
  assert.equal(cleanAction({ type: 'toggle', id: 'x', on: 'yes' }), null)
  assert.deepEqual(cleanAction({ type: 'pins', pins: ['mod-logic', 'mission'] }), { type: 'pins', pins: ['mod-logic', 'mission'] })
  assert.equal(cleanAction({ type: 'pins', pins: ['a b'] }), null)
  assert.equal(cleanAction(null), null)
})
