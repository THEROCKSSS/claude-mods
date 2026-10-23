// What memory-status reads and how it judges it. Pure: no $, so the tests call it directly.

export type Found = { url: string; workspace: string; pendingFile: string; server: string } | null
export type Container = { name: string; isUp: boolean; status: string; isCritical: boolean }
export type Verdict = 'ok' | 'degraded' | 'unknown'
export type Reading = {
  at: number
  verdict: Verdict
  gateway: 'up' | 'error' | 'down'
  gatewayStatus: number | null
  containers: Container[]
  pending: number
  reason: string // why it is degraded, in a few words; '' when ok
}

const slash = (p: string) => p.replace(/\\/g, '/')

// The memory server from a Claude Code config (~/.claude.json): its URL, and the workspace its
// pending-write queue lives under. Finds a server named like *memory* that sets SUPABASE_MEMORY_URL
// or runs a supabase-memory script, at the top level or in any project's mcpServers.
export function discover(claudeJson: unknown): Found {
  if (!claudeJson || typeof claudeJson !== 'object') return null
  const root = claudeJson as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> }
  const pools = [root.mcpServers ?? {}, ...Object.values(root.projects ?? {}).map(p => p?.mcpServers ?? {})]
  for (const pool of pools) {
    for (const [name, raw] of Object.entries(pool)) {
      const s = raw as { args?: unknown; env?: Record<string, unknown> }
      const env = s?.env ?? {}
      const args = Array.isArray(s?.args) ? s.args.filter((a): a is string => typeof a === 'string').map(slash) : []
      const script = args.find(a => /\/supabase-memory\//i.test(a))
      if (!/memory/i.test(name) && typeof env.SUPABASE_MEMORY_URL !== 'string' && !script) continue
      const url = (typeof env.SUPABASE_MEMORY_URL === 'string' ? env.SUPABASE_MEMORY_URL : 'http://127.0.0.1:8100').replace(/\/+$/, '')
      // The queue is <workspace>/output/supabase-memory-pending/pending.jsonl; the workspace is set,
      // or is the folder that holds projects/supabase-memory.
      const workspace = typeof env.SUPABASE_MEMORY_WORKSPACE === 'string' ? slash(env.SUPABASE_MEMORY_WORKSPACE) : script?.match(/^(.*)\/projects\/supabase-memory\//i)?.[1] ?? ''
      return { url, workspace, pendingFile: workspace ? `${workspace}/output/supabase-memory-pending/pending.jsonl` : '', server: name }
    }
  }
  return null
}

// `podman ps -a --format {{.Names}}|{{.Status}}` (or docker's) as name → status text.
export function parsePs(stdout: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf('|')
    if (at > 0) out.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  return out
}

export function countPending(text: string): number {
  return text.split(/\r?\n/).filter(l => l.trim()).length
}

// One reading from what was seen: the gateway answered (any status) or not, the containers'
// states, the queue. Degraded when the gateway is down or a critical container is not up.
export function judge(args: {
  at: number
  isConfigured: boolean
  gatewayStatus: number | null // null: no answer
  ps: Map<string, string> | null // null: no container runtime to ask
  critical: string[]
  optional: string[]
  pending: number
}): Reading {
  const { at, gatewayStatus, ps, critical, optional, pending } = args
  const gateway: Reading['gateway'] = gatewayStatus === null ? 'down' : gatewayStatus >= 500 ? 'error' : 'up'
  const containers: Container[] = ps
    ? [...critical.map(n => [n, true] as const), ...optional.map(n => [n, false] as const)]
        .filter(([n, isCritical]) => isCritical || ps.has(n))
        .map(([name, isCritical]) => {
          const status = ps.get(name) ?? 'not found'
          return { name, isCritical, status, isUp: /^up\b/i.test(status) }
        })
    : []
  const stopped = containers.filter(c => c.isCritical && !c.isUp).map(c => c.name)
  if (!args.isConfigured) return { at, verdict: 'unknown', gateway, gatewayStatus, containers, pending, reason: 'no memory server found' }
  const reason = gateway === 'down' ? `gateway not answering${stopped.length ? ` (${stopped.join(', ')} stopped)` : ''}` : gateway === 'error' ? `gateway error ${gatewayStatus}` : stopped.length ? `${stopped.join(', ')} stopped` : ''
  return { at, verdict: reason ? 'degraded' : 'ok', gateway, gatewayStatus, containers, pending, reason }
}

// The targeted restart for a compose file: only the critical services, never a blanket up or down.
export function fixCommand(runtime: string, composeFile: string, critical: string[]): string {
  const services = critical.map(c => c.replace(/^supabase-/, '')).join(' ')
  return composeFile ? `${runtime} compose -f "${composeFile}" up -d --no-deps ${services}` : ''
}
