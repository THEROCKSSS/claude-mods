// One listening port; hooks/ports.ts holds the same shape.
export type PortRow = {
  port: number
  pid: number
  process: string
  owner: string
  kind: 'dev' | 'app' | 'system'
  bind: 'local' | 'all' | 'tailnet' | 'other'
  address: string
  url: string
  phoneUrl: string
}

declare module 'claude-code' {
  interface PluginState {
    'port-watch': {
      rows: PortRow[]
      scannedAt: number
      scanning: boolean
      filter: 'dev' | 'phone' | 'all'
      query: string
      qr: number // the port whose QR code is open, 0 for none
      page: number
      tailnetIp: string
      error: string
    }
  }
}
