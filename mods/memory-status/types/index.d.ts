// One container memory needs, and one reading of the whole; hooks/check.ts holds the same shapes.
export type Container = { name: string; isUp: boolean; status: string; isCritical: boolean }
export type Reading = {
  at: number
  verdict: 'ok' | 'degraded' | 'unknown'
  gateway: 'up' | 'error' | 'down'
  gatewayStatus: number | null
  containers: Container[]
  pending: number
  reason: string
}
export type Change = { at: number; verdict: 'ok' | 'degraded' | 'unknown'; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'memory-status': {
      reading: Reading | null
      history: Change[] // the last state changes, newest first
      fix: string // the restart command, '' when there is none
      fixOutput: string // what the last run of the fix printed
      armed: boolean // Run fix was pressed once; a second press runs it
      busy: boolean
    }
  }
}
