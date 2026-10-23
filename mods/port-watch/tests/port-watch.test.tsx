import { describe, expect, mock, test } from 'claude-code/testing'

import { ownerOf, parseLsof, parseNetstat, parsePublished, parseServe, parseTasklist, qrSvg, rows } from '../hooks/ports'
import { shown } from '../hooks/register'

const NETSTAT = `
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1752
  TCP    0.0.0.0:8796           0.0.0.0:0              LISTENING       4484
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       900
  TCP    127.0.0.1:8100         0.0.0.0:0              LISTENING       77
  TCP    [::]:8796              [::]:0                 LISTENING       4484
  TCP    10.0.0.5:51000         20.1.1.1:443           ESTABLISHED     900
`
const TASKLIST = '"svchost.exe","1752","Services","0","1 K"\n"node.exe","4484","Console","1","2 K"\n"node.exe","900","Console","1","3 K"\n"gvproxy.exe","77","Console","1","4 K"\n'
const PODMAN = JSON.stringify([{ Names: ['supabase-kong'], Ports: [{ host_ip: '127.0.0.1', host_port: 8100, container_port: 8000 }] }])

describe('the scan', () => {
  test('netstat, tasklist and podman become one row per port, named and with phone URLs', () => {
    const listeners = parseNetstat(NETSTAT)
    expect(listeners.map(l => `${l.address}:${l.port}`)).toEqual(['0.0.0.0:135', '0.0.0.0:8796', '127.0.0.1:5173', '127.0.0.1:8100', '::8796'.replace('::8796', '::') + ':8796'])
    const out = rows({
      listeners,
      names: parseTasklist(TASKLIST),
      commandLines: new Map([[4484, '"node" "C:\\ws\\projects\\claude-mods\\mods\\mod-hub\\server\\hub.mjs" --port 8796'], [900, 'node C:\\dev\\vite-app\\node_modules\\vite\\bin\\vite.js']]),
      published: parsePublished(PODMAN),
      tailnetIp: '100.64.0.7',
    })
    expect(out.map(r => [r.port, r.owner, r.kind, r.bind, r.phoneUrl])).toEqual([
      [135, 'svchost', 'system', 'all', 'http://100.64.0.7:135/'],
      [5173, 'vite-app', 'dev', 'local', ''],
      [8100, 'supabase-kong (container :8000)', 'dev', 'local', ''],
      [8796, 'claude-mods', 'dev', 'all', 'http://100.64.0.7:8796/'],
    ])
    expect(shown(out, 'dev', '').map(r => r.port)).toEqual([5173, 8100, 8796])
    expect(shown(out, 'phone', '').map(r => r.port)).toEqual([8796]) // system ports hidden here too
    expect(shown(out, 'all', 'kong').map(r => r.port)).toEqual([8100])
  })

  test('Tailscale Serve names its ports, lends local servers its URL; desktop apps are not dev; unseen containers are added', () => {
    const served = parseServe(JSON.stringify({ TCP: { '10000': { HTTPS: true } }, Web: { 'pc.tail.ts.net:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5173' } } } } }))
    expect(served).toEqual([{ host: 'pc.tail.ts.net', port: 10000, targetPort: 5173 }])
    const out = rows({
      listeners: parseNetstat('  TCP    127.0.0.1:5173   0.0.0.0:0   LISTENING   900\n  TCP    100.64.0.7:10000   0.0.0.0:0   LISTENING   55\n  TCP    0.0.0.0:4455   0.0.0.0:0   LISTENING   66\n'),
      names: new Map([[900, 'node.exe'], [55, 'tailscaled.exe'], [66, 'obs64.exe']]),
      commandLines: new Map([[900, 'node C:\\dev\\vite-app\\node_modules\\vite\\bin\\vite.js']]),
      published: parsePublished(JSON.stringify([{ Names: ['supabase-kong'], Ports: [{ host_ip: '127.0.0.1', host_port: 8100, container_port: 8000 }] }])),
      served,
      tailnetIp: '100.64.0.7',
    })
    expect(out.map(r => [r.port, r.owner, r.kind, r.phoneUrl])).toEqual([
      [4455, 'obs64', 'app', 'http://100.64.0.7:4455/'],
      [5173, 'vite-app', 'dev', 'https://pc.tail.ts.net:10000/'], // local-only, but served: the phone gets the Serve URL
      [8100, 'supabase-kong (container :8000)', 'dev', ''], // not in netstat: added from podman
      [10000, 'serve → :5173 vite-app', 'dev', 'https://pc.tail.ts.net:10000/'],
    ])
    expect(ownerOf('C:\\py\\python.exe -m hermes_cli.main gateway run', 'python.exe')).toBe('hermes_cli')
  })

  test('lsof, npx owners, and a QR code', () => {
    expect(parseLsof('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 501 me 23u IPv4 0x1 0t0 TCP *:3000 (LISTEN)\n')).toEqual([{ process: 'node', pid: 501, address: '0.0.0.0', port: 3000 }])
    expect(ownerOf('"node" "C:\\npm\\npx-cli.js" -y rea-agents@6.7.0 mcp', 'node.exe')).toBe('rea-agents')
    const svg = qrSvg('http://100.64.0.7:8796/')
    expect(svg).toMatch(/^<svg[^>]+viewBox="0 0 (\d+) \1"/)
    expect((svg.match(/h1v1h-1z/g) ?? []).length).toBeGreaterThan(100)
  })
})

describe('port-watch', () => {
  test('/ports scans and the pane shows a QR for a phone-reachable port', async ($, on) => {
    mock.clock(on)
    on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
    on('command.register', () => ({ value: undefined }))
    on('fs.exists', () => ({ value: true }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [] }))
    on('process.run', (_$: any, e: any) => {
      const a: string[] = e.argv
      const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
      if (a[1] === 'ip') return ok('100.64.0.7\n')
      if (a[0] === 'podman') return ok(PODMAN)
      if (a[0] === 'netstat') return ok(a[3] === 'TCP' ? NETSTAT : '')
      if (a[0] === 'tasklist') return ok(TASKLIST)
      if (a[0] === 'powershell') return ok(JSON.stringify([{ ProcessId: 4484, CommandLine: 'node C:\\ws\\projects\\claude-mods\\x.mjs' }]))
      return ok('')
    })
    on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'below' }))
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\ws' } as any)
    const r: any = await $.command.run({ command: 'ports', args: '8796' } as any)
    expect(r.text).toBe('Ports: 3 dev servers listening, 1 reachable from your phone.') // svchost on 135 is reachable but not a dev server
    const pane = await $.ui.mount({ plugin: 'port-watch', surface: 'desktop', component: 'Pane', requestId: 'port-watch', props: { title: 'Ports', isFocused: true, bodyColumns: 90, placement: 'dock' } } as any)
    expect(await pane.find({ type: 'Text', text: ' PHONE OK ' })).toBeDefined()
    const code: any = await pane.find({ type: 'Svg' })
    expect(code.props.alt).toBe('QR code for http://100.64.0.7:8796/')
    await pane.unmount()
  })
})
