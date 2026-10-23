// Which mods a view shows, and in what order. Pure, with no `claude-code` import, so the
// /mod-manager pane and the web hub (web/src imports this file; it sits outside hooks/ so Vite finds shared/tsconfig.json) filter exactly alike.

export type Filter = 'all' | 'on' | 'off' | 'pinned' | 'commands' | 'changed' | 'new'
export type Sort = 'status' | 'name' | 'newest' | 'commands'

export type ViewMod = {
  id: string
  name: string
  marketplace: string
  description: string
  enabled: boolean
  installedAt: string
  commands: { name: string; description: string }[]
}

export type View = { query: string; filter: Filter; sort: Sort; source: string } // source '' is every marketplace
export type Context = { pins: readonly string[]; pending: readonly string[]; now: number }

export const DEFAULT_VIEW: View = { query: '', filter: 'all', sort: 'status', source: '' }
export const NEW_MS = 24 * 60 * 60 * 1000

export const FILTERS: { value: Filter; label: string; hint: string }[] = [
  { value: 'all', label: 'All', hint: 'every installed mod' },
  { value: 'on', label: 'On', hint: 'turned on' },
  { value: 'off', label: 'Off', hint: 'turned off' },
  { value: 'pinned', label: 'Pinned', hint: 'with a command on the bar' },
  { value: 'commands', label: 'Commands', hint: 'with slash commands' },
  { value: 'changed', label: 'Changed', hint: 'turned on or off, waiting on a reload' },
  { value: 'new', label: 'New', hint: 'installed in the last day' },
]

export const SORTS: { value: Sort; label: string }[] = [
  { value: 'status', label: 'On first' },
  { value: 'name', label: 'A to Z' },
  { value: 'newest', label: 'Newest' },
  { value: 'commands', label: 'Most commands' },
]

export function isNew(m: ViewMod, now: number): boolean {
  const at = Date.parse(m.installedAt)
  return Number.isFinite(at) && now - at < NEW_MS
}

export function matches(m: ViewMod, filter: Filter, ctx: Context): boolean {
  switch (filter) {
    case 'on':
      return m.enabled
    case 'off':
      return !m.enabled
    case 'pinned':
      return m.commands.some(c => ctx.pins.includes(c.name))
    case 'commands':
      return m.commands.length > 0
    case 'changed':
      return ctx.pending.includes(m.id)
    case 'new':
      return isNew(m, ctx.now)
    default:
      return true
  }
}

// Every word of the query must appear in the mod's name, description, marketplace or a command.
export function matchesQuery(m: ViewMod, query: string): boolean {
  const words = query.toLowerCase().replace(/\//g, ' ').split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = `${m.name} ${m.description} ${m.marketplace} ${m.commands.map(c => `${c.name} ${c.description}`).join(' ')}`.toLowerCase()
  return words.every(w => hay.includes(w))
}

const ORDER: Record<Sort, (a: ViewMod, b: ViewMod) => number> = {
  status: (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  newest: (a, b) => (Date.parse(b.installedAt) || 0) - (Date.parse(a.installedAt) || 0) || a.name.localeCompare(b.name),
  commands: (a, b) => b.commands.length - a.commands.length || a.name.localeCompare(b.name),
}

export function viewMods<M extends ViewMod>(mods: readonly M[], view: View, ctx: Context): M[] {
  return mods
    .filter(m => (!view.source || m.marketplace === view.source) && matches(m, view.filter, ctx) && matchesQuery(m, view.query))
    .sort(ORDER[view.sort] ?? ORDER.status)
}

// How many mods each filter would show, within the chosen marketplace and search, for the chips.
export function counts(mods: readonly ViewMod[], view: View, ctx: Context): Record<Filter, number> {
  const pool = mods.filter(m => (!view.source || m.marketplace === view.source) && matchesQuery(m, view.query))
  return Object.fromEntries(FILTERS.map(f => [f.value, pool.filter(m => matches(m, f.value, ctx)).length])) as Record<Filter, number>
}

export function sources(mods: readonly ViewMod[]): string[] {
  return [...new Set(mods.map(m => m.marketplace).filter(Boolean))].sort()
}

// A stored or posted view, with anything unknown put back to its default.
export function cleanView(v: unknown): View {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof View, unknown>>
  return {
    query: typeof o.query === 'string' ? o.query.slice(0, 200) : '',
    filter: FILTERS.some(f => f.value === o.filter) ? (o.filter as Filter) : 'all',
    sort: SORTS.some(s => s.value === o.sort) ? (o.sort as Sort) : 'status',
    source: typeof o.source === 'string' ? o.source.slice(0, 200) : '',
  }
}

export function isDefault(v: View): boolean {
  return v.query === '' && v.filter === 'all' && v.sort === 'status' && v.source === ''
}
