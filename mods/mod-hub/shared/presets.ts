// Presets: a named setup to come back to. A preset can turn mods on or off (only the mods it
// names), set the bar's pins, and run a list of commands. Pure, with no `claude-code` import:
// the mod applies presets, and the web hub (web/src imports this file) edits them the same way.

export type ModState = 'on' | 'off'
export type PresetStep = { command: string; args: string; enabled: boolean }
export type Preset = {
  id: string
  name: string
  note: string
  mods: Record<string, ModState> // plugin id → wanted state; a mod not listed is left as it is
  steps: PresetStep[]
  pins: string[] | null // null leaves the bar's pins alone
  by: 'you' | 'claude'
  updatedAt: number
}
export type RecentCommand = { command: string; args: string; at: number }

export const MAX_PRESETS = 30
export const MAX_STEPS = 20
const NAME = /^[\w:.-]{1,64}$/

// A command that flips something each time it runs: applying a preset twice would undo it.
export function isToggle(description: string): boolean {
  return /\b(show or hide|shows or hides|toggle|turns? it (?:on|off)|on or off|again turns|hide it|hides it)\b/i.test(description)
}

export function newId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'preset'
  let id = base
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`
  return id
}

// A preset from anywhere (the store, the web page, Claude's tool), kept to what is valid:
// known shapes, bounded sizes, command names that could be commands.
export function cleanPreset(raw: unknown, now: number): Preset | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const name = typeof p.name === 'string' ? p.name.trim().slice(0, 60) : ''
  if (!name) return null
  const mods: Record<string, ModState> = {}
  if (p.mods && typeof p.mods === 'object') {
    for (const [id, state] of Object.entries(p.mods as Record<string, unknown>).slice(0, 100)) {
      if (/^[\w.:@-]{1,200}$/.test(id) && (state === 'on' || state === 'off')) mods[id] = state
    }
  }
  const steps: PresetStep[] = []
  for (const s of Array.isArray(p.steps) ? p.steps.slice(0, MAX_STEPS) : []) {
    if (!s || typeof s !== 'object') continue
    const step = s as Record<string, unknown>
    const command = typeof step.command === 'string' ? step.command.trim().replace(/^\//, '') : ''
    if (!NAME.test(command)) continue
    steps.push({ command, args: typeof step.args === 'string' ? step.args.slice(0, 300) : '', enabled: step.enabled !== false })
  }
  const pins = Array.isArray(p.pins) ? [...new Set(p.pins.filter((x): x is string => typeof x === 'string' && NAME.test(x)))].slice(0, 12) : null
  return {
    id: typeof p.id === 'string' && /^[\w-]{1,60}$/.test(p.id) ? p.id : '',
    name,
    note: typeof p.note === 'string' ? p.note.slice(0, 300) : '',
    mods,
    steps,
    pins,
    by: p.by === 'claude' ? 'claude' : 'you',
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : now,
  }
}

// Saves a preset into the list: a new id for a new one, an update in place for a known id.
export function upsert(list: readonly Preset[], preset: Preset, now: number): Preset[] {
  const known = preset.id && list.some(p => p.id === preset.id)
  const id = known ? preset.id : newId(preset.name, list.map(p => p.id))
  const saved = { ...preset, id, updatedAt: now }
  return known ? list.map(p => (p.id === id ? saved : p)) : [...list, saved].slice(-MAX_PRESETS)
}

// The current setup as a preset: every mod as it is now, the bar's pins, and the commands the
// person ran recently, in order, once each. Toggles go in unticked, so applying it changes nothing.
export function snapshot(
  name: string,
  mods: readonly { id: string; enabled: boolean; isSelf: boolean; commands: { name: string; description: string }[] }[],
  pins: readonly string[],
  recent: readonly RecentCommand[],
  now: number,
): Preset {
  const describe = new Map(mods.flatMap(m => m.commands.map(c => [c.name, c.description] as const)))
  const seen = new Set<string>()
  const steps: PresetStep[] = []
  for (const r of recent) {
    const key = `${r.command} ${r.args}`.trim()
    if (seen.has(key) || !describe.has(r.command)) continue
    seen.add(key)
    steps.push({ command: r.command, args: r.args, enabled: !isToggle(describe.get(r.command) ?? '') })
  }
  return {
    id: '',
    name,
    note: '',
    mods: Object.fromEntries(mods.filter(m => !m.isSelf).map(m => [m.id, m.enabled ? 'on' : 'off'])),
    steps: steps.slice(0, MAX_STEPS),
    pins: [...pins],
    by: 'you',
    updatedAt: now,
  }
}

// What applying it would change now: the mods that flip, and the commands that run.
export function plan(preset: Preset, mods: readonly { id: string; enabled: boolean }[]) {
  const current = new Map(mods.map(m => [m.id, m.enabled]))
  const flips = Object.entries(preset.mods)
    .filter(([id, want]) => current.has(id) && current.get(id) !== (want === 'on'))
    .map(([id, want]) => ({ id, on: want === 'on' }))
  const missing = Object.keys(preset.mods).filter(id => !current.has(id))
  return { flips, steps: preset.steps.filter(s => s.enabled), missing }
}

// One line on what a preset does, for a card.
export function summary(preset: Preset): string {
  const on = Object.values(preset.mods).filter(s => s === 'on').length
  const off = Object.values(preset.mods).filter(s => s === 'off').length
  const steps = preset.steps.filter(s => s.enabled)
  return [
    on || off ? `${on} on${off ? `, ${off} off` : ''}` : '',
    steps.length ? `runs ${steps.map(s => `/${s.command}${s.args ? ` ${s.args}` : ''}`).join(', ')}` : '',
    preset.pins ? `${preset.pins.length} pinned` : '',
  ]
    .filter(Boolean)
    .join(' · ') || 'empty: add mods or commands'
}

// "0:42", "4:05", "58 min" for the cache countdown.
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  if (s >= 600) return `${Math.round(s / 60)} min`
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
