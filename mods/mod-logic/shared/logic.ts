// What a mod does, read off its source: the events it hooks, the $ capabilities it calls,
// and what it registers. Then one graph of every mod, laid out in 2D or 3D. Pure: no
// `claude-code` import, so the mod's pane and the hub's web view (which imports this file)
// read mods and draw the graph exactly alike.

export type Risk = 'runs' | 'network' | 'writes' | 'reads' | 'drives' | 'draws' | 'state' | 'time' | 'other'

export type ModLogic = {
  id: string // name@marketplace, or the folder for a mod that is not installed
  name: string
  enabled: boolean
  files: string[] // the module files read, relative to the mod's folder
  hooks: { event: string; matcher: string; count: number }[] // "tool.call" + "Bash"
  calls: { name: string; risk: Risk; count: number }[] // "process.run"
  commands: string[]
  tools: string[]
  state: string[]
  guards: number // hooks registered with a .catch handler
  lines: number
  error?: string // why it could not be read
}

export type NodeKind = 'mod' | 'event' | 'capability' | 'command' | 'tool' | 'state'
export type GraphNode = { id: string; kind: NodeKind; label: string; risk?: Risk; weight: number; mods: string[] }
export type GraphEdge = { from: string; to: string; kind: 'hooks' | 'calls' | 'registers' | 'keeps'; count: number }
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] }

export const RISKS: { value: Risk; label: string; color: string }[] = [
  { value: 'runs', label: 'runs programs', color: '#f08a5d' },
  { value: 'network', label: 'uses the network', color: '#e5566b' },
  { value: 'writes', label: 'writes files', color: '#e8c15a' },
  { value: 'drives', label: 'drives Claude', color: '#d98be0' },
  { value: 'reads', label: 'reads files', color: '#6cc5d9' },
  { value: 'draws', label: 'draws UI', color: '#8fd48a' },
  { value: 'state', label: 'keeps state', color: '#9aa7c7' },
  { value: 'time', label: 'uses timers', color: '#b9ad94' },
  { value: 'other', label: 'other', color: '#8a8274' },
]
export const KIND_COLOR: Record<NodeKind, string> = { mod: '#e3a857', event: '#7fb8a4', capability: '#9aa7c7', command: '#f0c27a', tool: '#d98be0', state: '#6f86b8' }

export function riskOf(call: string): Risk {
  const [noun, verb = ''] = call.split('.')
  if (noun === 'process') return 'runs'
  if (noun === 'http') return 'network'
  if (noun === 'fs') return verb === 'write' ? 'writes' : 'reads'
  if (noun === 'command' && verb === 'run') return 'drives'
  if (noun === 'prompt' || noun === 'agent' || noun === 'model' || (noun === 'tool' && verb === 'call')) return 'drives'
  if (noun === 'ui' || noun === 'audio') return 'draws'
  if (noun === 'store' || noun === 'state' || noun === 'settings' || noun === 'config' || noun === 'env' || noun === 'session') return 'state'
  if (noun === 'clock') return 'time'
  return 'other'
}

// Strips comments and the insides of strings that are not quoted names, so a word in a
// comment ("we never call $.http.fetch") is not read as a call.
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}

const count = <T extends string>(list: T[]) => {
  const m = new Map<T, number>()
  for (const x of list) m.set(x, (m.get(x) ?? 0) + 1)
  return m
}

// The relative modules a file imports (./x, ../y), for following a hooks module into its helpers.
export function importsOf(text: string): string[] {
  const out: string[] = []
  for (const m of code(text).matchAll(/\b(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g)) out.push(m[1]!)
  for (const m of code(text).matchAll(/\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) out.push(m[1]!)
  return out
}

// One mod's logic, from its module files' text.
export function analyze(id: string, name: string, enabled: boolean, files: Record<string, string>): ModLogic {
  const all = Object.values(files).map(code).join('\n')
  const hooks: { event: string; matcher: string }[] = []
  for (const m of all.matchAll(/\bon\(\s*['"]([\w.*:-]+)['"]\s*(?:,\s*\{([^{}]*)\})?/g)) {
    const matcher = (m[2] ?? '').match(/\b(?:tool|component|command|requestId|name|surface)\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? ''
    hooks.push({ event: m[1]!, matcher })
  }
  const calls = [...all.matchAll(/\$\.(\w+)\.(\w+)\s*\(/g)].map(m => `${m[1]}.${m[2]}`)
  const names = (re: RegExp) => [...new Set([...all.matchAll(re)].map(m => m[1]!))].sort()
  const hookCounts = count(hooks.map(h => `${h.event}\u0000${h.matcher}`))
  return {
    id,
    name,
    enabled,
    files: Object.keys(files).sort(),
    hooks: [...hookCounts].map(([k, n]) => ({ event: k.split('\u0000')[0]!, matcher: k.split('\u0000')[1]!, count: n })).sort((a, b) => a.event.localeCompare(b.event) || a.matcher.localeCompare(b.matcher)),
    calls: [...count(calls)].map(([c, n]) => ({ name: c, risk: riskOf(c), count: n })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    commands: names(/command\.register\(\s*\{[^}]*?\bname\s*:\s*['"]([\w:.-]+)['"]/g),
    tools: names(/tool\.register\(\s*\{[^}]*?\bname\s*:\s*['"]([\w:.-]+)['"]/g),
    state: names(/atom\(\s*\{[^}]*?\bkey\s*:\s*['"]([\w-]+)['"]/g),
    guards: (all.match(/\)\s*\.catch\(\s*[A-Za-z_$][\w$]*\s*\)/g) ?? []).length + (all.match(/\)\s*\.catch\(\s*\(\s*\$/g) ?? []).length,
    lines: Object.values(files).reduce((n, t) => n + t.split('\n').length, 0),
  }
}

const eventId = (event: string, matcher: string) => `event:${event}${matcher ? `:${matcher}` : ''}`

// Every mod joined to what it hooks, calls and registers. Events and capabilities are shared
// nodes, so mods that hook the same event or call the same capability meet there.
export function buildGraph(mods: ModLogic[]): Graph {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const node = (id: string, kind: NodeKind, label: string, mod: string, weight: number, risk?: Risk) => {
    const n = nodes.get(id) ?? { id, kind, label, weight: 0, mods: [], ...(risk ? { risk } : {}) }
    n.weight += weight
    if (!n.mods.includes(mod)) n.mods.push(mod)
    nodes.set(id, n)
    return id
  }
  for (const m of mods) {
    if (m.error) continue
    const modId = node(`mod:${m.id}`, 'mod', m.name, m.id, m.lines)
    for (const h of m.hooks) edges.push({ from: modId, to: node(eventId(h.event, h.matcher), 'event', h.matcher ? `${h.event} · ${h.matcher}` : h.event, m.id, h.count), kind: 'hooks', count: h.count })
    for (const c of m.calls) edges.push({ from: modId, to: node(`cap:${c.name}`, 'capability', `$.${c.name}`, m.id, c.count, c.risk), kind: 'calls', count: c.count })
    for (const c of m.commands) edges.push({ from: modId, to: node(`cmd:${c}`, 'command', `/${c}`, m.id, 1), kind: 'registers', count: 1 })
    for (const t of m.tools) edges.push({ from: modId, to: node(`tool:${t}`, 'tool', `tool ${t}`, m.id, 1), kind: 'registers', count: 1 })
    for (const s of m.state) edges.push({ from: modId, to: node(`state:${m.id}:${s}`, 'state', s, m.id, 1), kind: 'keeps', count: 1 })
  }
  return { nodes: [...nodes.values()], edges }
}

// The part of the graph one mod touches: the mod, its neighbours, and the other mods that share them.
export function focusGraph(g: Graph, modId: string): Graph {
  const center = `mod:${modId}`
  const near = new Set([center, ...g.edges.filter(e => e.from === center).map(e => e.to)])
  const sharing = new Set(g.edges.filter(e => near.has(e.to) && e.from !== center).map(e => e.from))
  const keep = new Set([...near, ...sharing])
  return { nodes: g.nodes.filter(n => keep.has(n.id)), edges: g.edges.filter(e => keep.has(e.from) && keep.has(e.to) && (e.from === center || near.has(e.to))) }
}

// Only the kinds asked for (mods always stay), and edges between what is left.
export function filterKinds(g: Graph, kinds: readonly NodeKind[]): Graph {
  const keep = new Set(g.nodes.filter(n => n.kind === 'mod' || kinds.includes(n.kind)).map(n => n.id))
  return { nodes: g.nodes.filter(n => keep.has(n.id)), edges: g.edges.filter(e => keep.has(e.from) && keep.has(e.to)) }
}

// A seeded random, so one graph lays out the same way every time and a live update moves little.
function seeded(text: string) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

export type Placed = Record<string, [number, number, number]>

// Mods sit fixed on a ring (2D) or a sphere (3D), in name order; everything else is laid out
// inside by force: pulled toward the mods that use it, pushed apart from its neighbours. So a
// part many mods share sits near the middle, and one mod's own parts sit by that mod.
// Positions fall within -1..1.
export function layout(g: Graph, dims: 2 | 3, iterations = 220): Placed {
  const pos: Placed = {}
  const mods = g.nodes.filter(n => n.kind === 'mod').sort((a, b) => a.label.localeCompare(b.label))
  mods.forEach((n, i) => {
    if (dims === 2) {
      const a = (i / Math.max(1, mods.length)) * Math.PI * 2 - Math.PI / 2
      pos[n.id] = [Math.cos(a), Math.sin(a), 0]
    } else {
      // A Fibonacci sphere: even spacing for any count.
      const y = mods.length === 1 ? 0 : 1 - (i / (mods.length - 1)) * 2
      const r = Math.sqrt(1 - y * y)
      const a = i * Math.PI * (3 - Math.sqrt(5))
      pos[n.id] = [Math.cos(a) * r, y, Math.sin(a) * r]
    }
  })
  const free = g.nodes.filter(n => n.kind !== 'mod').map(n => n.id)
  const fixed = new Set(mods.map(m => m.id))
  const neighbours = new Map<string, string[]>()
  for (const e of g.edges) {
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from])
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to])
  }
  // Start each part at the middle of its mods, nudged by a seeded jitter so two never coincide.
  for (const id of free) {
    const r = seeded(id)
    const near = (neighbours.get(id) ?? []).filter(x => fixed.has(x)).map(x => pos[x]!)
    const c = near.length ? [0, 1, 2].map(k => near.reduce((s, p) => s + p[k]!, 0) / near.length) : [0, 0, 0]
    pos[id] = [c[0]! * 0.7 + (r() - 0.5) * 0.2, c[1]! * 0.7 + (r() - 0.5) * 0.2, dims === 3 ? c[2]! * 0.7 + (r() - 0.5) * 0.2 : 0]
  }
  const spacing = (dims === 3 ? 0.5 : 0.44) / Math.sqrt(Math.max(1, free.length / 24))
  for (let it = 0; it < iterations; it++) {
    const step = 0.06 * (1 - it / iterations) + 0.003
    for (const id of free) {
      const p = pos[id]!
      const f = [0, 0, 0]
      // Pull toward the middle of the mods it belongs to, averaged so a part every mod shares
      // is pulled no harder than one two mods share: then spacing, not popularity, decides.
      const near = (neighbours.get(id) ?? []).map(x => pos[x]).filter((q): q is [number, number, number] => q !== undefined)
      if (near.length) for (let k = 0; k < dims; k++) f[k]! += (near.reduce((s, q) => s + q[k]!, 0) / near.length - p[k]!) * 0.5
      // Push away from other parts closer than the spacing.
      for (const other of free) {
        if (other === id) continue
        const q = pos[other]!
        const d = [p[0] - q[0], p[1] - q[1], p[2] - q[2]]
        const dist = Math.max(0.005, Math.hypot(d[0]!, d[1]!, d[2]!))
        if (dist < spacing) for (let k = 0; k < dims; k++) f[k]! += (d[k]! / dist) * (spacing - dist) * 1.4
      }
      const len = Math.hypot(f[0]!, f[1]!, f[2]!)
      if (len > 0) for (let k = 0; k < dims; k++) p[k]! += (f[k]! / len) * Math.min(len, step)
      // Inside the ring or sphere of mods.
      const out = Math.hypot(p[0], p[1], p[2])
      if (out > 0.84) for (let k = 0; k < 3; k++) p[k]! *= 0.84 / out
    }
  }
  return pos
}

// Mods, and only the parts at least `min` mods share: where mods meet. A focused view keeps everything.
export function sharedOnly(g: Graph, min = 2): Graph {
  const keep = new Set(g.nodes.filter(n => n.kind === 'mod' || n.mods.length >= min).map(n => n.id))
  return { nodes: g.nodes.filter(n => keep.has(n.id)), edges: g.edges.filter(e => keep.has(e.from) && keep.has(e.to)) }
}

export function nodeColor(n: GraphNode): string {
  return n.kind === 'capability' ? (RISKS.find(r => r.value === n.risk)?.color ?? KIND_COLOR.capability) : KIND_COLOR[n.kind]
}

export function nodeSize(n: GraphNode): number {
  return n.kind === 'mod' ? 7 + Math.min(6, Math.sqrt(n.weight) / 5) : 3.5 + Math.min(7, n.mods.length * 0.9)
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// The desktop's Svg element takes at most 131,072 characters; a drawing past this drops part labels.
const SVG_BUDGET = 120_000

// The graph as an SVG document for the pane's Svg element: hover a shape for its <title>.
export function graphSvg(g: Graph, opts: { width: number; height: number; focus?: string; changed?: string; labels?: 'all' | 'mods' } = { width: 900, height: 560 }): string {
  const { width: W, height: H } = opts
  const pos = layout(g, 2)
  const pad = 64
  const scale = Math.min(W, H) / 2 - pad
  const xy = (id: string) => {
    const p = pos[id] ?? [0, 0, 0]
    return [W / 2 + p[0] * scale * (W > H ? 1.35 : 1), H / 2 + p[1] * scale] as const
  }
  const labels = opts.labels ?? 'all'
  // Only the most shared parts get a label, so the middle stays readable; hover gives the rest.
  const named = new Set(g.nodes.filter(n => n.kind !== 'mod' && n.mods.length >= 3).sort((a, b) => b.mods.length - a.mods.length).slice(0, 14).map(n => n.id))
  const o: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, system-ui, sans-serif">`,
    `<rect width="${W}" height="${H}" rx="14" fill="#1b1814"/>`,
  ]
  if (g.nodes.length === 0) {
    o.push(`<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="15" fill="#8a8274">No mod logic to draw yet</text></svg>`)
    return o.join('')
  }
  for (const e of g.edges) {
    const [x1, y1] = xy(e.from)
    const [x2, y2] = xy(e.to)
    const hot = opts.focus && e.from === `mod:${opts.focus}`
    o.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${hot ? '#e3a857' : '#544c40'}" stroke-opacity="${hot ? 0.85 : 0.4}" stroke-width="${hot ? 1.6 : 1}"/>`)
  }
  for (const n of g.nodes) {
    const [x, y] = xy(n.id)
    const r = nodeSize(n)
    const color = nodeColor(n)
    const isChanged = opts.changed && n.id === `mod:${opts.changed}`
    const who = n.kind === 'mod' ? '' : `\nused by ${n.mods.length} mod${n.mods.length === 1 ? '' : 's'}: ${n.mods.map(m => m.replace(/@.*$/, '')).join(', ')}`
    o.push(`<g><title>${esc(`${n.label} (${n.kind}${n.risk ? `, ${n.risk}` : ''})${who}`)}</title>`)
    if (isChanged) o.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r + 6).toFixed(1)}" fill="none" stroke="#e8d27a" stroke-width="2" stroke-dasharray="3 3"/>`)
    o.push(
      n.kind === 'mod'
        ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" stroke="#1b1814" stroke-width="2"/>`
        : n.kind === 'event'
          ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${color}" stroke-width="2"/>`
          : `<rect x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${(2 * r).toFixed(1)}" height="${(2 * r).toFixed(1)}" rx="2" fill="${color}" fill-opacity="0.9"/>`,
    )
    const isLabelled = n.kind === 'mod' || (labels === 'all' && named.has(n.id))
    if (isLabelled) {
      const text = n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label
      const below = n.kind === 'mod' ? y > H / 2 : true // ring labels face outward
      const ly = n.kind === 'mod' ? (below ? y + r + 14 : y - r - 7) : y + r + 12
      o.push(`<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="${n.kind === 'mod' ? 12 : 10.5}" font-weight="${n.kind === 'mod' ? 600 : 400}" fill="${n.kind === 'mod' ? '#ece6da' : '#c9c0b0'}" stroke="#1b1814" stroke-width="3" paint-order="stroke">${esc(text)}</text>`)
    }
    o.push('</g>')
  }
  o.push('</svg>')
  const out = o.join('')
  return out.length > SVG_BUDGET && labels === 'all' ? graphSvg(g, { ...opts, labels: 'mods' }) : out
}
