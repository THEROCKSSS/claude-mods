// The shapes shared/logic.ts works with, restated: a state contract holds no imports.
export type Risk = 'runs' | 'network' | 'writes' | 'reads' | 'drives' | 'draws' | 'state' | 'time' | 'other'
export type NodeKind = 'mod' | 'event' | 'capability' | 'command' | 'tool' | 'state'

export type ModLogic = {
  id: string
  name: string
  enabled: boolean
  files: string[]
  hooks: { event: string; matcher: string; count: number }[]
  calls: { name: string; risk: Risk; count: number }[]
  commands: string[]
  tools: string[]
  state: string[]
  guards: number
  lines: number
  error?: string
}

// The last edit that changed a mod's logic: which mod, which file, when.
export type LogicChange = { mod: string; file: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'mod-logic': {
      logic: ModLogic[]
      changed: LogicChange | null
      tab: 'map' | 'breakdown'
      focus: string // a mod id, '' for every mod
      kinds: NodeKind[] // which kinds of node the map shows besides mods
      shared: boolean // the map shows only parts two or more mods share
      page: number
    }
  }
}
