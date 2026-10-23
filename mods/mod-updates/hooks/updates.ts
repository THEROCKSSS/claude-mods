// What mod-updates compares. Pure: no $, so the tests call it directly.

export type Installed = { id: string; name: string; market: string; version: string; sha: string }
export type MarketSource = { kind: 'git'; dir: string } | { kind: 'folder'; dir: string } | { kind: 'other' }
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
  note: string // why it could not be checked, or what an update does here
}

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

// installed_plugins.json (version 2) as one row per plugin id.
export function readInstalled(json: unknown): Installed[] {
  const plugins = ((json as { plugins?: Record<string, unknown> } | null)?.plugins ?? {}) as Record<string, unknown>
  return Object.entries(plugins).flatMap(([id, rows]) => {
    const row = (Array.isArray(rows) ? rows[0] : undefined) as Record<string, unknown> | undefined
    if (!row) return []
    const at = id.lastIndexOf('@')
    return [{ id, name: at > 0 ? id.slice(0, at) : id, market: at > 0 ? id.slice(at + 1) : '', version: String(row.version ?? ''), sha: typeof row.gitCommitSha === 'string' ? row.gitCommitSha : '' }]
  })
}

// known_marketplaces.json as how each marketplace can be checked: a git clone, a folder, or neither.
export function readMarkets(json: unknown, isGit: (dir: string) => boolean): Map<string, MarketSource> {
  const out = new Map<string, MarketSource>()
  for (const [name, raw] of Object.entries((json ?? {}) as Record<string, { source?: { source?: string; path?: string }; installLocation?: string }>)) {
    const dir = raw?.installLocation ? slash(raw.installLocation) : ''
    if (raw?.source?.source === 'directory') out.set(name, { kind: 'folder', dir: slash(raw.source.path ?? dir) })
    else if (dir && isGit(dir)) out.set(name, { kind: 'git', dir })
    else out.set(name, { kind: 'other' })
  }
  return out
}

// A marketplace.json's entries: plugin name → its folder in the repo (no ./) and its listed version.
export function readCatalog(json: unknown): Map<string, { path: string; version: string }> {
  const out = new Map<string, { path: string; version: string }>()
  for (const p of ((json as { plugins?: unknown[] } | null)?.plugins ?? []) as { name?: unknown; source?: unknown; version?: unknown }[]) {
    if (typeof p.name !== 'string') continue
    const source = typeof p.source === 'string' ? p.source.replace(/^\.\/?/, '').replace(/\/+$/, '') : ''
    out.set(p.name, { path: source, version: typeof p.version === 'string' ? p.version : '' })
  }
  return out
}

// `git log --format=%h%x09%s` lines as commits.
export function parseLog(stdout: string): Commit[] {
  return stdout
    .split(/\r?\n/)
    .filter(l => l.includes('\t'))
    .map(l => ({ sha: l.slice(0, l.indexOf('\t')), subject: l.slice(l.indexOf('\t') + 1).trim() }))
}

// Newest first: those with updates, then the rest by name.
export function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => Number(b.hasUpdate) - Number(a.hasUpdate) || a.name.localeCompare(b.name))
}

// Whether a version string is ahead of another (1.2.10 > 1.2.9; a suffix like -win.2 counts after).
export function isNewer(to: string, from: string): boolean {
  if (!to || to === from) return false
  const parts = (v: string) => v.split(/[.-]/).map(x => (/^\d+$/.test(x) ? Number(x) : x))
  const a = parts(to)
  const b = parts(from)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return false
    if (y === undefined) return true
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x > y
    return String(x) > String(y)
  }
  return false
}
