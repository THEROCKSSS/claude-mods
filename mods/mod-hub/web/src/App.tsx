import { ArrowLeft, Command as CommandIcon, Pin, RefreshCw, Search } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Kbd } from './components/ui/kbd'
import { isDemo, useHub, useNow, useRoute, type Action, type HubState, type Link, type ModRow } from './hub'
import { ModCard } from './ModCard'
import { LoadGuard } from './LoadGuard'
import { Logic } from './Logic'
import { Palette } from './Palette'
import { Mission } from './Mission'
import { Presets } from './Presets'
import { countdown } from '../../shared/presets'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'
import { cleanView, counts, DEFAULT_VIEW, FILTERS, isDefault, SORTS, sources, viewMods, type View } from '../../shared/view'

// three.js is most of the bundle: the page draws first and the constellation joins when it has loaded.
const Constellation = lazy(() => import('./Constellation').then(m => ({ default: m.Constellation })))

export function App() {
  const { state, stateAt, graph, mission, link, send, hasToken } = useHub()
  const route = useRoute()
  const [view, setView] = useStoredView()
  const [highlight, setHighlight] = useState<string | null>(null)
  const [isPaletteOpen, setPaletteOpen] = useState(false)
  const search = useRef<HTMLInputElement>(null)

  const act = useCallback(
    async (action: Action, said: string) => {
      if (isDemo) return void toast.info('Demo with NON-LIVE DATA: nothing runs here', { description: `With mod-hub installed: ${said}` })
      try {
        await send(action)
        toast.success(said)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'The hub did not answer')
      }
    },
    [send],
  )
  const run = (command: string) => act({ type: 'run', command }, `Sent /${command} to Claude Code`)
  const reload = () => act({ type: 'reload' }, 'Reloading plugins')
  const toggle = (mod: ModRow, on: boolean) => act({ type: 'toggle', id: mod.id, on }, `Turning ${mod.name} ${on ? 'on' : 'off'}`)
  const pin = (command: string) => {
    if (!state) return
    const pins = state.pins.includes(command) ? state.pins.filter(p => p !== command) : [...state.pins, command].slice(0, 12)
    void act({ type: 'pins', pins }, state.pins.includes(command) ? `Unpinned /${command}` : `Pinned /${command} to the bar`)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(o => !o)
      } else if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-6 pt-8 pb-16 sm:px-8">
      <Header link={link} stateAt={stateAt} state={state} onPalette={() => setPaletteOpen(true)} onReload={reload} />
      <Nav route={route.name} />
      {isDemo && (
        <div className="mt-6 rounded-lg border border-brass/40 bg-brass/10 px-4 py-3 text-sm">
          <span className="font-semibold tracking-wider text-brass">NON-LIVE DATA</span> · A saved snapshot of a real setup, so you can look around. Buttons explain what they would do; nothing runs.{' '}
          <a className="font-medium text-foreground underline underline-offset-4" href="https://github.com/THEROCKSSS/claude-mods#install">
            Install mod-hub
          </a>{' '}
          for your own live hub.
        </div>
      )}
      {!hasToken ? (
        <Notice title="Open the hub from Claude Code">This page needs the address the hub prints. Run /hub in Claude Code, or press ◈ Hub in the bar above the prompt.</Notice>
      ) : !state ? (
        <Notice title="Waiting for Claude Code…">
          The hub is running, but no session has reported in yet. A Claude Code session with mod-hub installed connects within 15 seconds; /hub connects it at once.
        </Notice>
      ) : route.name === 'mission' ? (
        <Mission feed={mission} />
      ) : route.name === 'presets' ? (
        <Presets state={state} act={act} />
      ) : route.name === 'logic' ? (
        <Logic feed={graph} focusId={route.id} />
      ) : route.name === 'mod' ? (
        <Detail id={route.id} state={state} highlight={highlight} onHighlight={setHighlight} onRun={run} onToggle={toggle} onPin={pin} />
      ) : (
        <Home
          state={state}
          view={view}
          highlight={highlight}
          search={search}
          onView={setView}
          onHighlight={setHighlight}
          onRun={run}
          onToggle={toggle}
          onPin={pin}
        />
      )}
      {state && <Palette open={isPaletteOpen} onOpenChange={setPaletteOpen} state={state} onRun={run} onReload={reload} />}
      <footer className="mt-16 border-t pt-4 text-xs text-muted-foreground">
        Every change goes through your Claude Code session: the page asks, the mod checks it against what is installed, then runs it. On and off take effect after a reload.
      </footer>
    </div>
  )
}

function Header({ link, stateAt, state, onPalette, onReload }: { link: Link; stateAt: number; state: HubState | null; onPalette: () => void; onReload: () => void }) {
  const now = useNow(1_000)
  const label = { live: 'LIVE DATA', stale: 'NOT UPDATING', offline: 'HUB OFFLINE', connecting: 'CONNECTING', demo: 'NON-LIVE DATA' }[link]
  const tone = link === 'live' ? 'border-sage/40 text-sage' : link === 'connecting' ? 'border-border text-muted-foreground' : 'border-brass/50 text-brass'
  return (
    <header className="flex flex-wrap items-end justify-between gap-6 border-b pb-6">
      <div>
        <p className="text-xs tracking-[0.18em] text-muted-foreground uppercase">Claude Code</p>
        <h1 className="font-display text-5xl leading-none font-semibold tracking-tight">Mod Hub</h1>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-left text-xs text-muted-foreground sm:text-right">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-semibold tracking-wider ${tone}`}>
            <span className={`size-1.5 rounded-full bg-current ${link === 'live' ? 'animate-pulse' : ''}`} aria-hidden />
            {label}
          </span>
          <div className="mt-1">
            {link === 'demo' ? 'Demo snapshot' : stateAt ? `Heard from Claude Code ${Math.max(0, Math.round((now - stateAt) / 1000))} s ago` : 'Not heard from Claude Code yet'}
            {state?.claudeVersion ? ` · ${state.claudeVersion}` : ''}
          </div>
          <CacheTimer cache={state?.cache ?? null} now={now} />
        </div>
        {state && state.pending.length > 0 && (
          <Button onClick={onReload} className="bg-brass text-primary-foreground hover:bg-brass/90">
            <RefreshCw aria-hidden /> Reload to apply ({state.pending.length})
          </Button>
        )}
        <Button variant="outline" onClick={onPalette} disabled={!state} aria-keyshortcuts="Control+K Meta+K">
          <CommandIcon aria-hidden /> Run a command <Kbd>Ctrl K</Kbd>
        </Button>
      </div>
    </header>
  )
}

type HomeProps = {
  state: HubState
  view: View
  highlight: string | null
  search: React.RefObject<HTMLInputElement | null>
  onView: (change: Partial<View>) => void
  onHighlight: (id: string | null) => void
  onRun: (c: string) => void
  onToggle: (m: ModRow, on: boolean) => void
  onPin: (c: string) => void
}

function Home({ state, view, highlight, search, onView, onHighlight, onRun, onToggle, onPin }: HomeProps) {
  const reduce = useReducedMotion()
  const on = state.mods.filter(m => m.enabled).length
  const commandCount = state.mods.reduce((n, m) => n + m.commands.length, 0)
  const runnable = new Set([...state.mods.flatMap(m => m.commands.map(c => c.name)), ...state.otherCommands.map(c => c.name)])
  const pins = state.pins.filter(p => runnable.has(p))
  const lit = highlight ? state.mods.find(m => m.id === highlight) : undefined

  const now = useNow(60_000)
  const ctx = useMemo(() => ({ pins: state.pins, pending: state.pending, now }), [state.pins, state.pending, now])
  // This mod always leads the list, wherever the sort would put it.
  const shown = useMemo(() => viewMods(state.mods, view, ctx).sort((a, b) => Number(b.isSelf) - Number(a.isSelf)), [state.mods, view, ctx])
  const tally = useMemo(() => counts(state.mods, view, ctx), [state.mods, view, ctx])
  const markets = sources(state.mods)

  return (
    <main className="flex flex-col gap-8 pt-8">
      <section className="grid gap-6 max-lg:grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]" aria-label="Overview">
        <div className="relative h-[340px] overflow-hidden rounded-2xl border bg-[radial-gradient(ellipse_at_center,oklch(0.22_0.02_70),oklch(0.16_0.008_70))]">
          <LoadGuard what="constellation">
          <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted-foreground">Drawing the constellation…</div>}>
            <Constellation mods={state.mods} pending={state.pending} highlight={highlight} onHighlight={onHighlight} onOpen={id => (location.hash = `#/mod/${encodeURIComponent(id)}`)} />
          </Suspense>
          </LoadGuard>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-background/90 to-transparent p-4 text-sm">
            <span className="font-display text-lg">{lit ? lit.name : 'Your mods'}</span>
            <span className="text-xs text-muted-foreground">{lit ? (lit.enabled ? 'on' : 'off') + (lit.commands.length ? ` · ${lit.commands.length} command${lit.commands.length === 1 ? '' : 's'}` : '') : 'hover a light · click to open'}</span>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-3 gap-3">
            <Stat value={state.mods.length} label="installed" />
            <Stat value={on} label="on" accent />
            <Stat value={commandCount} label="mod commands" />
          </dl>
          <div className="flex flex-1 flex-col gap-3 rounded-2xl border bg-card/60 p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold">The bar</h2>
              <span className="text-xs text-muted-foreground">above your prompt in Claude Code</span>
            </div>
            {pins.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing pinned yet. Press <Pin className="inline size-3.5" aria-label="the pin" /> beside any command to put it on the bar, one click from the chat.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {pins.map(p => (
                  <Button key={p} variant="secondary" size="sm" className="font-mono text-primary" onClick={() => onRun(p)}>
                    /{p}
                  </Button>
                ))}
              </div>
            )}
            <p className="mt-auto text-xs text-muted-foreground">
              Off a mod for good? Switch it off, then reload. Its lights dim here and its commands leave the palette.
            </p>
          </div>
        </div>
      </section>

      <section aria-label="Mods" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 rounded-2xl border bg-card/40 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-64 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input ref={search} value={view.query} onChange={e => onView({ query: e.target.value })} placeholder="Search mods and commands  ( / )" className="pl-9" aria-label="Search mods and commands" />
            </div>
            <Select value={view.sort} onValueChange={v => onView({ sort: v as View['sort'] })}>
              <SelectTrigger className="w-44" aria-label="Sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map(o => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {markets.length > 1 && (
              <Select value={view.source || ALL_SOURCES} onValueChange={v => onView({ source: v === ALL_SOURCES ? '' : v })}>
                <SelectTrigger className="w-52" aria-label="Marketplace">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SOURCES}>Every marketplace</SelectItem>
                  {markets.map(m => (
                    <SelectItem key={m} value={m}>
                      @{m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter">
            {FILTERS.filter(f => f.value === 'all' || tally[f.value] > 0 || view.filter === f.value).map(f => (
              <Button key={f.value} size="sm" variant={view.filter === f.value ? 'default' : 'outline'} aria-pressed={view.filter === f.value} title={f.hint} onClick={() => onView({ filter: f.value })}>
                {f.label}
                <span className={`font-mono text-xs ${view.filter === f.value ? 'opacity-80' : 'text-muted-foreground'}`}>{tally[f.value]}</span>
              </Button>
            ))}
            <span className="ml-auto text-xs text-muted-foreground">
              {shown.length === state.mods.length ? `${shown.length} mods` : `${shown.length} of ${state.mods.length} mods`}
            </span>
            {!isDefault(view) && (
              <Button size="sm" variant="ghost" onClick={() => onView({ ...DEFAULT_VIEW })}>
                Reset
              </Button>
            )}
          </div>
        </div>
        {shown.length === 0 ? (
          <Notice title="Nothing matches">{`No mod is ${FILTERS.find(f => f.value === view.filter)?.hint ?? "here"}${view.query ? ` and matches “${view.query}”` : ""}. Reset the view to see them all.`}</Notice>
        ) : (
          <motion.div layout={!reduce} className="grid gap-4 max-sm:grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
            <AnimatePresence mode="popLayout">
              {shown.map((m, i) => (
                <ModCard
                  key={m.id}
                  mod={m}
                  index={i}
                  pins={state.pins}
                  isPending={state.pending.includes(m.id)}
                  isLit={highlight === m.id}
                  onToggle={onToggle}
                  onRun={onRun}
                  onPin={onPin}
                  onHighlight={onHighlight}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </section>
    </main>
  )
}

function Detail({ id, state, highlight, onHighlight, onRun, onToggle, onPin }: { id: string; state: HubState; highlight: string | null; onHighlight: (id: string | null) => void; onRun: (c: string) => void; onToggle: (m: ModRow, on: boolean) => void; onPin: (c: string) => void }) {
  const mod = state.mods.find(m => m.id === id)
  useEffect(() => {
    document.title = mod ? `${mod.name} · Mod Hub` : 'Mod Hub'
    return () => {
      document.title = 'Mod Hub'
    }
  }, [mod])
  return (
    <main className="flex max-w-3xl flex-col gap-5 pt-8">
      <a href="#/" className="inline-flex w-fit items-center gap-1.5 text-sm text-primary hover:underline">
        <ArrowLeft className="size-4" aria-hidden /> All mods
      </a>
      {mod ? (
        <>
          <ModCard mod={mod} index={0} pins={state.pins} isPending={state.pending.includes(mod.id)} isLit={highlight === mod.id} isDetail onToggle={onToggle} onRun={onRun} onPin={onPin} onHighlight={onHighlight} />
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <Fact term="Plugin id" detail={mod.id} />
            <Fact term="Installed" detail={mod.installedAt ? new Date(mod.installedAt).toLocaleString() : 'unknown'} />
            <Fact term="Commands" detail={String(mod.commands.length)} />
          </dl>
        </>
      ) : (
        <Notice title="Not installed now">
          No mod called <code className="font-mono">{id}</code> is installed in this session. It may have been removed.
        </Notice>
      )}
    </main>
  )
}

function Stat({ value, label, accent = false }: { value: number; label: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border bg-card/60 px-4 py-3">
      <dd className={`font-display text-3xl font-semibold ${accent ? 'text-primary' : ''}`}>{value}</dd>
      <dt className="text-xs text-muted-foreground">{label}</dt>
    </div>
  )
}

function Fact({ term, detail }: { term: string; detail: string }) {
  return (
    <div className="rounded-xl border bg-card/50 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="truncate font-mono text-xs" title={detail}>
        {detail}
      </dd>
    </div>
  )
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-8 rounded-2xl border border-dashed p-10 text-center">
      <h2 className="font-display text-2xl font-semibold">{title}</h2>
      <p className="mx-auto mt-2 max-w-prose text-sm text-muted-foreground">{children}</p>
      <Badge variant="outline" className="mt-4">
        LIVE DATA once connected
      </Badge>
    </div>
  )
}

const ALL_SOURCES = '__every__' // a Select item cannot have an empty value
const VIEW_KEY = 'mod-hub-view'

// The filter, sort and marketplace, kept in this browser across visits; the search starts empty.
function useStoredView(): [View, (change: Partial<View>) => void] {
  const [view, set] = useState<View>(() => {
    try {
      return { ...cleanView(JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null')), query: '' }
    } catch {
      return DEFAULT_VIEW
    }
  })
  const change = useCallback((c: Partial<View>) => {
    set(prev => {
      const next = { ...prev, ...c }
      try {
        localStorage.setItem(VIEW_KEY, JSON.stringify({ ...next, query: '' }))
      } catch {
        // private windows can refuse storage: the view still works for this visit
      }
      return next
    })
  }, [])
  return [view, change]
}

// Mods and Logic: the hub's two places, each its own route.
function Nav({ route }: { route: 'home' | 'mod' | 'logic' | 'presets' | 'mission' }) {
  const tab = (href: string, label: string, isOn: boolean) => (
    <a
      href={href}
      aria-current={isOn ? 'page' : undefined}
      className={`rounded-md px-3 py-1.5 text-sm transition-[color,background-color] ${isOn ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
    >
      {label}
    </a>
  )
  return (
    <nav className="mt-4 flex gap-1" aria-label="Hub">
      {tab('#/', 'Mods', route === 'home' || route === 'mod')}
      {tab('#/presets', 'Presets', route === 'presets')}
      {tab('#/logic', 'Logic graph', route === 'logic')}
      {tab('#/mission', 'Mission', route === 'mission')}
    </nav>
  )
}

// How long the prompt cache stays warm after Claude Code's last request: warm, the last minute, cold.
function CacheTimer({ cache, now }: { cache: { at: number; ttlMs: number; isLearned: boolean } | null; now: number }) {
  if (!cache) return <div className="mt-1 text-xs text-muted-foreground">◷ cache · no request yet</div>
  const left = cache.at + cache.ttlMs - now
  const life = cache.ttlMs >= 3_600_000 ? '1 h' : '5 min'
  const tone = left <= 0 ? 'text-muted-foreground' : left <= 60_000 ? 'text-brass' : 'text-sage'
  return (
    <div className={`mt-1 text-xs font-medium tabular-nums ${tone}`} title={`A ${life} prompt cache${cache.isLearned ? '' : ' (assumed until a request shows it lasts longer)'}`}>
      {left > 0 ? `◷ cache warm · ${countdown(left)} left` : `◷ cache cold · next message re-reads it`}
    </div>
  )
}
