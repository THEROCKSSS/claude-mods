// A view of the mod list; shared/view.ts holds the same shape with its logic.
export type View = { query: string; filter: 'all' | 'on' | 'off' | 'pinned' | 'commands' | 'changed' | 'new'; sort: 'status' | 'name' | 'newest' | 'commands'; source: string }

// One installed plugin (a mod or a classic plugin) as the hub and the pane show it.
export type ModRow = {
  id: string // name@marketplace
  name: string
  marketplace: string
  version: string
  description: string
  enabled: boolean
  installedAt: string
  commands: { name: string; description: string }[]
  isSelf: boolean // mod-hub itself: never turned off from here
}

// What the hub web app is told, and what the band and the pane draw from.
export type HubState = {
  generatedAt: number
  claudeVersion?: string
  mods: ModRow[]
  // Commands not from a plugin: Claude Code's own, the person's, MCP prompts. For the palette.
  otherCommands: { name: string; description: string; source: string }[]
  pins: string[] // command names shown as buttons in the bar
  pending: string[] // plugin ids turned on or off since the last reload
}

declare module 'claude-code' {
  interface PluginState {
    'mod-hub': {
      state: HubState | null
      hubUrl: string // '' until the hub server answers
      note: string // the last thing that went wrong, shown in the pane
      view: View // search, filter, sort and marketplace; kept across sessions
      compact: boolean // one line per mod instead of a card
      clickMode: 'run' | 'copy' // what pressing a command does, in the pane and the bar
      page: number
      busy: string // the plugin id being turned on or off, '' when none
    }
  }
}
