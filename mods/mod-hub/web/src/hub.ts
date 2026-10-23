// The page's line to the hub server: the state the mod sends, live over SSE, and the
// actions the page queues for the mod to run. Shapes mirror mods/mod-hub/types/index.d.ts.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import type { ModLogic } from '../../../mod-logic/shared/logic'

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
}

// What mod-logic sends: every mod read off its source, and the last edit that changed one.
export type LogicFeed = { mods: ModLogic[]; changed: { mod: string; file: string; at: number } | null }

export type Action =
  | { type: 'run'; command: string; args?: string }
  | { type: 'toggle'; id: string; on: boolean }
  | { type: 'reload' }
  | { type: 'pins'; pins: string[] }

// The mod sends its state at least every ~10 s while the session runs; past this, the page says so.
const STALE_MS = 25_000

const token = document.querySelector<HTMLMetaElement>('meta[name="mod-hub-token"]')?.content ?? ''

export type Link = 'connecting' | 'live' | 'stale' | 'offline'

export function useHub() {
  const [state, setState] = useState<HubState | null>(null)
  const [stateAt, setStateAt] = useState(0)
  const [isOpen, setIsOpen] = useState(false)
  const [graph, setGraph] = useState<LogicFeed | null>(null)
  const now = useNow(5_000)

  useEffect(() => {
    if (!token || token === '__MOD_HUB_TOKEN__') return
    const source = new EventSource(`api/events?token=${encodeURIComponent(token)}`)
    source.onopen = () => setIsOpen(true)
    source.onerror = () => setIsOpen(false) // EventSource retries by itself
    source.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data) as { state: HubState | null; stateAt: number; graph?: LogicFeed | null }
        if (msg.graph) setGraph(msg.graph)
        if (msg.state) {
          setState(msg.state)
          setStateAt(msg.stateAt)
        }
      } catch {
        // a malformed frame is skipped; the next one replaces it
      }
    }
    return () => source.close()
  }, [])

  const send = useCallback(async (action: Action) => {
    const r = await fetch('api/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mod-hub-token': token },
      body: JSON.stringify(action),
    })
    if (!r.ok) throw new Error(`the hub refused it (${r.status})`)
  }, [])

  const link: Link = !isOpen ? (state ? 'offline' : 'connecting') : !state ? 'connecting' : now - stateAt > STALE_MS ? 'stale' : 'live'
  return { state, stateAt, graph, link, send, hasToken: token !== '' && token !== '__MOD_HUB_TOKEN__' }
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
export type Route = { name: 'home' } | { name: 'mod'; id: string } | { name: 'logic'; id: string }

function readRoute(): Route {
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
