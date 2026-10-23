// The page's line to the hub server: the state the mod sends, live over SSE, and the
// actions the page queues for the mod to run. Shapes mirror mods/mod-hub/types/index.d.ts.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import type { ModLogic } from '../../../mod-logic/shared/logic'
import type { Preset, RecentCommand } from '../../shared/presets'

export type ModRow = {
  id: string
  name: string
  marketplace: string
  version: string
  description: string
  enabled: boolean
  installedAt: string
  commands: { name: string; description: string }[]
  isSelf: boolean
}

export type HubState = {
  generatedAt: number
  claudeVersion?: string
  mods: ModRow[]
  otherCommands: { name: string; description: string; source: string }[]
  pins: string[]
  pending: string[]
  presets: Preset[]
  recent: RecentCommand[]
  cache: { at: number; ttlMs: number; isLearned: boolean } | null
}

// What mod-logic sends: every mod read off its source, and the last edit that changed one.
export type LogicFeed = { mods: ModLogic[]; changed: { mod: string; file: string; at: number } | null }

// What mission-control-win sends: the live tree, the files on the map, and the map itself.
export type MissionFeed = {
  at: number
  turn: number
  summary: { agents: number; running: number; tools: number; failed: number }
  lines: { prefix: string; text: string; status: 'running' | 'done' | 'failed'; kind: 'main' | 'agent' | 'tool'; family: string }[]
  files: { path: string; act: string; changed: boolean; why: string }[]
  svg: string
}

export type Action =
  | { type: 'run'; command: string; args?: string }
  | { type: 'toggle'; id: string; on: boolean }
  | { type: 'reload' }
  | { type: 'pins'; pins: string[] }
  | { type: 'preset-save'; preset: Preset }
  | { type: 'preset-delete'; id: string }
  | { type: 'preset-apply'; id: string }
  | { type: 'preset-snapshot'; name: string }

// The mod sends its state at least every ~10 s while the session runs; past this, the page says so.
const STALE_MS = 25_000

const token = document.querySelector<HTMLMetaElement>('meta[name="mod-hub-token"]')?.content ?? ''

// The public demo (npm run build:demo, for GitHub Pages): a saved snapshot of a real setup, no hub,
// nothing runs. Fixed at build time, so the normal build drops the snapshot entirely.
export const isDemo = import.meta.env.VITE_DEMO === '1'

export type Link = 'connecting' | 'live' | 'stale' | 'offline' | 'demo'

export function useHub() {
  const [state, setState] = useState<HubState | null>(null)
  const [stateAt, setStateAt] = useState(0)
  const [isOpen, setIsOpen] = useState(false)
  const [graph, setGraph] = useState<LogicFeed | null>(null)
  const [mission, setMission] = useState<MissionFeed | null>(null)
  const now = useNow(5_000)

  useEffect(() => {
    if (!isDemo) return
    void import('./demo-data.json').then(({ default: d }) => {
      const at = Date.now()
      const s = d.state as unknown as HubState
      // The snapshot's clocks start now, so the cache countdown and "ago" labels read as a live session would.
      setState({ ...s, generatedAt: at, cache: { at: at - 75_000, ttlMs: 3_600_000, isLearned: true }, recent: s.recent.map((r, i) => ({ ...r, at: at - (i + 1) * 240_000 })) })
      setStateAt(at)
      setGraph({ ...(d.graph as unknown as LogicFeed), changed: { ...(d.graph as unknown as LogicFeed).changed!, at: at - 30_000 } })
      setMission({ ...(d.mission as unknown as MissionFeed), at })
    })
  }, [])

  useEffect(() => {
    if (isDemo || !token || token === '__MOD_HUB_TOKEN__') return
    const source = new EventSource(`api/events?token=${encodeURIComponent(token)}`)
    source.onopen = () => setIsOpen(true)
    source.onerror = () => setIsOpen(false) // EventSource retries by itself
    source.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data) as { state: HubState | null; stateAt: number; graph?: LogicFeed | null; mission?: MissionFeed | null }
        if (msg.graph) setGraph(msg.graph)
        if (msg.mission) setMission(msg.mission)
        if (msg.state) {
          // An older mod-hub sends no presets, recent commands or cache: start those empty.
          const sent = msg.state as Partial<HubState> & Omit<HubState, 'presets' | 'recent' | 'cache'>
          setState({ ...sent, presets: sent.presets ?? [], recent: sent.recent ?? [], cache: sent.cache ?? null })
          setStateAt(msg.stateAt)
        }
      } catch {
        // a malformed frame is skipped; the next one replaces it
      }
    }
    return () => source.close()
  }, [])

  const send = useCallback(async (action: Action) => {
    if (isDemo) return
    const r = await fetch('api/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mod-hub-token': token },
      body: JSON.stringify(action),
    })
    if (!r.ok) throw new Error(`the hub refused it (${r.status})`)
  }, [])

  const link: Link = isDemo ? 'demo' : !isOpen ? (state ? 'offline' : 'connecting') : !state ? 'connecting' : now - stateAt > STALE_MS ? 'stale' : 'live'
  return { state, stateAt, graph, mission, link, send, hasToken: isDemo || (token !== '' && token !== '__MOD_HUB_TOKEN__') }
}

// The time, moved on every `ms`, for "updated 4 s ago" and staleness.
export function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

// The hash route: #/ for the hub, #/mod/<id> for one mod. Bookmarks and reloads land where they were.
export type Route = { name: 'home' } | { name: 'mod'; id: string } | { name: 'logic'; id: string } | { name: 'presets' } | { name: 'mission' }

function readRoute(): Route {
  if (/^#\/presets\/?$/.test(location.hash)) return { name: 'presets' }
  if (/^#\/mission\/?$/.test(location.hash)) return { name: 'mission' }
  const logic = location.hash.match(/^#\/logic(?:\/(.+))?$/)
  if (logic) return { name: 'logic', id: logic[1] ? decodeURIComponent(logic[1]) : '' }
  const m = location.hash.match(/^#\/mod\/(.+)$/)
  return m ? { name: 'mod', id: decodeURIComponent(m[1]!) } : { name: 'home' }
}

let routeCache = readRoute()
function subscribe(cb: () => void) {
  const on = () => {
    routeCache = readRoute()
    cb()
  }
  window.addEventListener('hashchange', on)
  return () => window.removeEventListener('hashchange', on)
}

export function useRoute() {
  return useSyncExternalStore(subscribe, () => routeCache)
}

export const modHref = (id: string) => `#/mod/${encodeURIComponent(id)}`
