// One installed mod as the check found it; hooks/updates.ts holds the same shape.
export type Commit = { sha: string; subject: string }
export type Row = {
  id: string
  name: string
  market: string
  from: string
  to: string
  commits: Commit[]
  kind: 'git' | 'folder' | 'other'
  hasUpdate: boolean
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'mod-updates': {
      rows: Row[]
      checkedAt: number // 0 before the first check
      checking: boolean
      updating: string // the plugin id updating now, '' when none
      updated: string[] // ids updated this session: a reload applies them
      showAll: boolean // the pane lists up-to-date mods too
      error: string
    }
  }
}
