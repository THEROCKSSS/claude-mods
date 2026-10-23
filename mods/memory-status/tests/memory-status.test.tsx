import { describe, expect, mock, test } from 'claude-code/testing'

import { countPending, discover, fixCommand, judge, parsePs } from '../hooks/check'

const CLAUDE_JSON = {
  mcpServers: {
    'supabase-memory': {
      type: 'stdio',
      command: 'python.exe',
      args: ['C:\\ws\\projects\\supabase-memory\\scripts\\mcp_stdio.py'],
      env: { SUPABASE_MEMORY_URL: 'http://127.0.0.1:8100/' },
    },
  },
}
const PS_OK = 'supabase-kong|Up 22 hours (healthy)\nsupabase-rest|Up 22 hours (healthy)\nsupabase-db|Up 22 hours (healthy)\nsupabase-meta|Exited (1) 2 hours ago\n'
const CRITICAL = ['supabase-kong', 'supabase-rest', 'supabase-db']

describe('the checks', () => {
  test('finds the server, its URL and its queue from ~/.claude.json', () => {
    expect(discover(CLAUDE_JSON)).toEqual({ url: 'http://127.0.0.1:8100', workspace: 'C:/ws', pendingFile: 'C:/ws/output/supabase-memory-pending/pending.jsonl', server: 'supabase-memory' })
    expect(discover({ projects: { 'C:/x': { mcpServers: { mem: { env: { SUPABASE_MEMORY_URL: 'http://h:1', SUPABASE_MEMORY_WORKSPACE: 'D:\\w' } } } } } })?.pendingFile).toBe('D:/w/output/supabase-memory-pending/pending.jsonl')
    expect(discover({ mcpServers: { github: { args: ['x'] } } })).toBeNull()
  })

  test('judges: a 401 is up, a stopped critical container or no answer is degraded, optional ones never are', () => {
    const base = { at: 1, isConfigured: true, critical: CRITICAL, optional: ['supabase-meta'], pending: 0 }
    const ok = judge({ ...base, gatewayStatus: 401, ps: parsePs(PS_OK) })
    expect(ok.verdict).toBe('ok')
    expect(ok.containers.map(c => [c.name, c.isUp])).toEqual([['supabase-kong', true], ['supabase-rest', true], ['supabase-db', true], ['supabase-meta', false]])
    const down = judge({ ...base, gatewayStatus: null, ps: parsePs(PS_OK.replace('supabase-kong|Up 22 hours (healthy)', 'supabase-kong|Exited (0) 1 hour ago')) })
    expect(down).toMatchObject({ verdict: 'degraded', gateway: 'down', reason: 'gateway not answering (supabase-kong stopped)' })
    expect(judge({ ...base, gatewayStatus: 502, ps: null }).reason).toBe('gateway error 502')
    expect(judge({ ...base, isConfigured: false, gatewayStatus: null, ps: null }).verdict).toBe('unknown')
    expect(countPending('{"a":1}\n\n{"b":2}\n')).toBe(2)
    expect(fixCommand('podman', 'C:/ws/docker/core.yml', CRITICAL)).toBe('podman compose -f "C:/ws/docker/core.yml" up -d --no-deps kong rest db')
  })
})

// The engine beneath: a config naming the server, podman, a gateway, a queue with one write.
function engine(on: any, opts: { gateway: number | null; ps: string }) {
  const toasts: string[] = []
  const runs: string[][] = []
  const fwd = (p: string) => p.replace(/\\/g, '/')
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('fs.read', (_$: any, e: any) => {
    const p = fwd(e.path)
    if (p === 'C:/Users/me/.claude.json') return { value: JSON.stringify(CLAUDE_JSON) }
    if (p.endsWith('/pending.jsonl')) return { value: '{"operation":"set_fact"}\n' }
    throw new Error('ENOENT')
  })
  on('fs.exists', (_$: any, e: any) => ({ value: fwd(e.path) === 'C:/ws/docker/core.yml' }))
  on('process.run', (_$: any, e: any) => {
    runs.push(e.argv)
    if (e.argv[1] === '--version') return { value: { exitCode: e.argv[0] === 'podman' ? 0 : 1, stdout: 'podman 5', stderr: '' } }
    if (e.argv[1] === 'ps') return { value: { exitCode: 0, stdout: opts.ps, stderr: '' } }
    return { value: { exitCode: 0, stdout: 'started', stderr: '' } }
  })
  on('http.fetch', () => {
    if (opts.gateway === null) throw new Error('ECONNREFUSED') // nothing listening
    return { value: { status: opts.gateway, ok: false, headers: {}, text: '' } }
  })
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'below' }))
  return { toasts, runs, clock }
}
const BAR = { plugin: 'memory-status', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 120 } }
const PANE = { plugin: 'memory-status', surface: 'desktop', component: 'Pane', requestId: 'memory-status', props: { title: 'Memory Status', isFocused: true, bodyColumns: 90, placement: 'dock' } }

describe('memory-status', () => {
  test('the bar says ok with the queue count; the pane lists the containers', async ($, on) => {
    engine(on, { gateway: 401, ps: PS_OK })
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\ws' } as any)
    const r: any = await $.command.run({ command: 'memory-status', args: '' } as any)
    expect(r.text).toBe('Memory ok · 1 queued')
    const bar = await $.ui.mount(BAR as any)
    expect(await bar.find({ type: 'Text', text: '◉ memory ok' })).toBeDefined()
    expect(await bar.find({ type: 'Text', text: '· 1 write queued' })).toBeDefined()
    await bar.unmount()
    const pane = await $.ui.mount(PANE as any)
    expect(await pane.find({ type: 'Text', text: 'supabase-meta' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /up -d --no-deps kong rest db/ })).toBeDefined()
    await pane.unmount()
  })

  test('degraded when kong stops, and the fix runs only on the second press', async ($, on) => {
    const { runs } = engine(on, { gateway: null, ps: PS_OK.replace('supabase-kong|Up 22 hours (healthy)', 'supabase-kong|Exited (0) 1 hour ago') })
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\ws' } as any)
    await $.command.run({ command: 'memory-status', args: '' } as any)
    const bar = await $.ui.mount(BAR as any)
    expect(await bar.find({ type: 'Text', text: '◌ memory degraded' })).toBeDefined()
    await bar.unmount()
    const pane = await $.ui.mount(PANE as any)
    await pane.press({ key: 'run-fix' })
    expect(runs.some(a => a[0] === 'powershell')).toBe(false) // armed, not run
    await pane.press({ key: 'run-fix' })
    expect(runs.some(a => a[0] === 'powershell' && a.at(-1)!.includes('up -d --no-deps kong rest db'))).toBe(true)
    await pane.unmount()
  })
})
