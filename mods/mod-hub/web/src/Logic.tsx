// #/logic and #/logic/<mod>: how every mod works, as one graph, in 2D or 3D. The data comes from
// mod-logic (it reads each mod's source and sends it on every edit); the layout and colours
// come from mod-logic's own shared/logic.ts, so this view and its pane always agree.
import { Box, CircleDot, Orbit, Radio } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'

import { buildGraph, filterKinds, focusGraph, layout, nodeColor, nodeSize, RISKS, sharedOnly, type Graph, type GraphNode, type ModLogic, type NodeKind } from '../../../mod-logic/shared/logic'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'
import { Switch } from './components/ui/switch'
import { useNow, type LogicFeed } from './hub'
import { LoadGuard } from './LoadGuard'

const Logic3D = lazy(() => import('./Logic3D').then(m => ({ default: m.Logic3D })))

const KINDS: { value: NodeKind; label: string }[] = [
  { value: 'event', label: 'Events' },
  { value: 'capability', label: 'Capabilities' },
  { value: 'command', label: 'Commands' },
  { value: 'tool', label: 'Tools' },
  { value: 'state', label: 'State' },
]
const EVERY = '__every__'

export function Logic({ feed, focusId }: { feed: LogicFeed | null; focusId: string }) {
  const [dims, setDims] = useState<'2d' | '3d'>(() => (localStorage.getItem('mod-hub-logic-dims') === '3d' ? '3d' : '2d'))
  const [kinds, setKinds] = useState<NodeKind[]>(['event', 'capability', 'command'])
  const [isShared, setShared] = useState(true)
  const [hover, setHover] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const now = useNow(1_000)

  useEffect(() => {
    try {
      localStorage.setItem('mod-hub-logic-dims', dims)
    } catch {
      // storage refused: the toggle still works for this visit
    }
  }, [dims])

  const mods = useMemo(() => (feed?.mods ?? []).filter(m => !m.error), [feed])
  const graph = useMemo(() => {
    const full = buildGraph(mods)
    const shown = filterKinds(focusId ? focusGraph(full, focusId) : full, kinds)
    return focusId || !isShared ? shown : sharedOnly(shown)
  }, [mods, focusId, kinds, isShared])

  const focusTo = (id: string) => (location.hash = id ? `#/logic/${encodeURIComponent(id)}` : '#/logic')
  const changed = feed?.changed && now - feed.changed.at < 30_000 ? feed.changed : null
  const detail = graph.nodes.find(n => n.id === (picked ?? hover)) ?? null
  const focusedMod = focusId ? mods.find(m => m.id === focusId) : undefined

  if (!feed) {
    return (
      <div className="mt-8 rounded-2xl border border-dashed p-10 text-center">
        <h2 className="font-display text-2xl font-semibold">Waiting for mod-logic…</h2>
        <p className="mx-auto mt-2 max-w-prose text-sm text-muted-foreground">
          The graph comes from the mod-logic mod. Install it (<code className="font-mono">claude plugin install mod-logic@owen-mods</code>), reload, and run /mod-logic once; it sends every mod here and again on each edit.
        </p>
      </div>
    )
  }

  return (
    <main className="flex flex-col gap-5 pt-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-3xl font-semibold">How your mods work</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {mods.length} mods, read off their source: what each hooks, what it calls, what it registers. Parts two mods share are where they meet.
          </p>
        </div>
        <Badge variant="outline" className={changed ? 'border-brass/60 text-brass' : 'text-muted-foreground'}>
          <Radio className={changed ? 'animate-pulse' : ''} aria-hidden />
          {changed ? `${changed.mod.replace(/@.*$/, '')} changed ${Math.round((now - changed.at) / 1000)} s ago · ${changed.file}` : 'live: edit a mod and it redraws'}
        </Badge>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card/40 p-3">
        <div className="flex rounded-lg border p-0.5" role="group" aria-label="View">
          <Button size="sm" variant={dims === '2d' ? 'default' : 'ghost'} aria-pressed={dims === '2d'} onClick={() => setDims('2d')}>
            <CircleDot aria-hidden /> 2D
          </Button>
          <Button size="sm" variant={dims === '3d' ? 'default' : 'ghost'} aria-pressed={dims === '3d'} onClick={() => setDims('3d')}>
            <Orbit aria-hidden /> 3D
          </Button>
        </div>
        <Select value={focusId || EVERY} onValueChange={v => focusTo(v === EVERY ? '' : v)}>
          <SelectTrigger className="w-56" aria-label="Mod">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={EVERY}>Every mod</SelectItem>
            {mods.map(m => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kinds shown">
          {KINDS.map(k => {
            const isOn = kinds.includes(k.value)
            return (
              <Button key={k.value} size="sm" variant={isOn ? 'secondary' : 'outline'} aria-pressed={isOn} onClick={() => setKinds(ks => (isOn ? ks.filter(x => x !== k.value) : [...ks, k.value]))}>
                {k.label}
              </Button>
            )
          })}
        </div>
        {!focusId && (
          <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={isShared} onCheckedChange={setShared} aria-label="Only parts two or more mods share" />
            Shared only
          </label>
        )}
      </div>

      <div className="grid gap-5 max-lg:grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="relative h-[620px] overflow-hidden rounded-2xl border bg-[#1b1814]">
          {graph.nodes.length === 0 ? (
            <p className="grid h-full place-items-center text-sm text-muted-foreground">Nothing to draw with these filters.</p>
          ) : dims === '2d' ? (
            <Graph2D graph={graph} lit={picked ?? hover} focusId={focusId} changedMod={changed?.mod} onHover={setHover} onPick={id => (id.startsWith('mod:') ? focusTo(id.slice(4)) : setPicked(p => (p === id ? null : id)))} />
          ) : (
            <LoadGuard what="3D view">
            <Suspense fallback={<p className="grid h-full place-items-center text-sm text-muted-foreground">Building the 3D view…</p>}>
              <Logic3D graph={graph} lit={picked ?? hover} changedMod={changed?.mod} onHover={setHover} onPick={id => (id.startsWith('mod:') ? focusTo(id.slice(4)) : setPicked(p => (p === id ? null : id)))} />
            </Suspense>
            </LoadGuard>
          )}
          <Legend />
        </div>
        <aside className="flex flex-col gap-4">
          <Detail node={detail} graph={graph} onFocus={focusTo} />
          {focusedMod && <Breakdown mod={focusedMod} />}
        </aside>
      </div>
    </main>
  )
}

// The 2D view: the same ring layout as the pane, drawn in React so hover and click are live.
function Graph2D({ graph, lit, focusId, changedMod, onHover, onPick }: { graph: Graph; lit: string | null; focusId: string; changedMod?: string; onHover: (id: string | null) => void; onPick: (id: string) => void }) {
  const reduce = useReducedMotion()
  const pos = useMemo(() => layout(graph, 2), [graph])
  const W = 1000
  const H = 620
  const xy = (id: string) => {
    const p = pos[id] ?? [0, 0, 0]
    return [W / 2 + p[0] * 400, H / 2 - 22 + p[1] * 236] as const // room below for the legend
  }
  const near = useMemo(() => {
    if (!lit) return null
    return new Set([lit, ...graph.edges.filter(e => e.from === lit || e.to === lit).flatMap(e => [e.from, e.to])])
  }, [lit, graph])
  const named = new Set(graph.nodes.filter(n => n.kind !== 'mod' && n.mods.length >= 3).sort((a, b) => b.mods.length - a.mods.length).slice(0, 14).map(n => n.id))

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" role="img" aria-label={`Graph of ${graph.nodes.length} parts`}>
      {graph.edges.map((e, i) => {
        const [x1, y1] = xy(e.from)
        const [x2, y2] = xy(e.to)
        const isHot = near ? near.has(e.from) && near.has(e.to) && (e.from === lit || e.to === lit) : focusId !== '' && e.from === `mod:${focusId}`
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={isHot ? '#e3a857' : '#544c40'} strokeOpacity={near && !isHot ? 0.12 : isHot ? 0.9 : 0.4} strokeWidth={isHot ? 1.8 : 1} />
      })}
      {graph.nodes.map(n => {
        const [x, y] = xy(n.id)
        const r = nodeSize(n) * 1.15
        const color = nodeColor(n)
        const dim = near && !near.has(n.id)
        const isChanged = changedMod && n.id === `mod:${changedMod}`
        const showLabel = n.kind === 'mod' || named.has(n.id) || n.id === lit
        return (
          <g
            key={n.id}
            opacity={dim ? 0.25 : 1}
            style={{ cursor: 'pointer', transition: reduce ? undefined : 'opacity 150ms ease' }}
            onMouseEnter={() => onHover(n.id)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onPick(n.id)}
          >
            <title>{`${n.label} (${n.kind}${n.risk ? `, ${n.risk}` : ''})`}</title>
            {isChanged && <circle cx={x} cy={y} r={r + 8} fill="none" stroke="#e8d27a" strokeWidth={2} strokeDasharray="3 3" className={reduce ? '' : 'animate-spin [animation-duration:6s] [transform-box:fill-box] [transform-origin:center]'} />}
            {n.kind === 'mod' ? (
              <circle cx={x} cy={y} r={r} fill={color} stroke="#1b1814" strokeWidth={2} />
            ) : n.kind === 'event' ? (
              <circle cx={x} cy={y} r={r} fill="#1b1814" stroke={color} strokeWidth={2} />
            ) : (
              <rect x={x - r} y={y - r} width={2 * r} height={2 * r} rx={2} fill={color} fillOpacity={0.9} />
            )}
            {showLabel && (
              <text x={x} y={n.kind === 'mod' && y < H / 2 ? y - r - 7 : y + r + 14} textAnchor="middle" fontSize={n.kind === 'mod' ? 13 : 11} fontWeight={n.kind === 'mod' ? 600 : 400} fill={n.kind === 'mod' ? '#ece6da' : '#c9c0b0'} stroke="#1b1814" strokeWidth={3} paintOrder="stroke">
                {n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

function Legend() {
  return (
    <div className="pointer-events-none absolute right-3 bottom-3 left-3 flex flex-wrap gap-x-4 gap-y-1 rounded-xl bg-background/70 px-3 py-2 text-[11px] text-muted-foreground backdrop-blur-sm">
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full bg-[#e3a857]" aria-hidden /> mod
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-full border-2 border-[#7fb8a4]" aria-hidden /> event it hooks
      </span>
      {RISKS.filter(r => r.value !== 'other').map(r => (
        <span key={r.value} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[2px]" style={{ background: r.color }} aria-hidden /> {r.label}
        </span>
      ))}
    </div>
  )
}

function Detail({ node, graph, onFocus }: { node: GraphNode | null; graph: Graph; onFocus: (id: string) => void }) {
  if (!node) {
    return (
      <div className="rounded-2xl border bg-card/60 p-5 text-sm text-muted-foreground">
        <Box className="mb-2 size-4" aria-hidden />
        Hover a shape to see what it is and which mods use it. Click a mod to focus on it; click any other shape to pin it here.
      </div>
    )
  }
  const links = graph.edges.filter(e => e.from === node.id || e.to === node.id).length
  return (
    <div className="flex flex-col gap-3 rounded-2xl border bg-card/60 p-5">
      <div>
        <p className="text-xs tracking-[0.14em] text-muted-foreground uppercase">{node.kind}{node.risk ? ` · ${RISKS.find(r => r.value === node.risk)?.label}` : ''}</p>
        <h3 className="font-display text-xl font-semibold break-words" style={{ color: nodeColor(node) }}>
          {node.label}
        </h3>
      </div>
      <p className="text-sm text-muted-foreground">{node.kind === 'mod' ? `${links} connections shown` : `Used by ${node.mods.length} mod${node.mods.length === 1 ? '' : 's'}`}</p>
      {node.kind !== 'mod' && (
        <div className="flex flex-wrap gap-1.5">
          {node.mods.map(m => (
            <Button key={m} size="sm" variant="secondary" onClick={() => onFocus(m)}>
              {m.replace(/@.*$/, '')}
            </Button>
          ))}
        </div>
      )}
      {node.kind === 'mod' && (
        <Button size="sm" variant="outline" onClick={() => onFocus(node.id.slice(4))}>
          Focus on {node.label}
        </Button>
      )}
    </div>
  )
}

function Breakdown({ mod }: { mod: ModLogic }) {
  const isFailOpen = mod.hooks.some(h => h.event === 'tool.call' || h.event === 'tool.check') && mod.guards === 0
  return (
    <div className="flex flex-col gap-3 rounded-2xl border bg-card/60 p-5 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-display text-lg font-semibold">{mod.name}</h3>
        <span className="font-mono text-xs text-muted-foreground">{mod.lines} lines</span>
      </div>
      <Section title="Hooks">{mod.hooks.map(h => `${h.event}${h.matcher ? ` · ${h.matcher}` : ''}${h.count > 1 ? ` ×${h.count}` : ''}`)}</Section>
      <div>
        <p className="mb-1 text-xs tracking-wider text-muted-foreground uppercase">Calls</p>
        <div className="flex flex-wrap gap-1">
          {mod.calls.map(c => (
            <span key={c.name} className="rounded-md border px-1.5 py-0.5 font-mono text-[11px]" style={{ color: RISKS.find(r => r.value === c.risk)?.color }}>
              $.{c.name}
              {c.count > 1 ? ` ×${c.count}` : ''}
            </span>
          ))}
        </div>
      </div>
      {mod.commands.length > 0 && <Section title="Commands">{mod.commands.map(c => `/${c}`)}</Section>}
      {mod.state.length > 0 && <Section title="State">{mod.state}</Section>}
      {isFailOpen && <p className="rounded-lg border border-brass/40 bg-brass/10 p-2 text-xs text-brass">It hooks tool calls with no .catch handler: if the hook throws, the call goes ahead unchecked.</p>}
      <p className="text-xs text-muted-foreground">Read from {mod.files.join(', ')}</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: string[] }) {
  return (
    <div>
      <p className="mb-1 text-xs tracking-wider text-muted-foreground uppercase">{title}</p>
      <p className="font-mono text-xs leading-relaxed">{children.length ? children.join(',  ') : 'none'}</p>
    </div>
  )
}
