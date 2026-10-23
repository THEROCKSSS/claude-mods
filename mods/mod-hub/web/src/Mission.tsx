// #/mission: Mission Control at full size. The tree of the main loop, its subagents and every tool
// call, live; and the code map of the files Claude reads and edits. mission-control-win sends both
// (its ↗ Browser button, and every couple of seconds while anything changes).
import { Bot, FileCode2, Maximize2, Minimize2, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { useNow, type MissionFeed } from './hub'

const FAMILY: Record<string, string> = { bash: '#f08a5d', edit: '#ffa24c', read: '#5aa9ff', search: '#9aa7c7', browser: '#d98be0', agent: '#e3a857', main: '#e3a857' }

export function Mission({ feed }: { feed: MissionFeed | null }) {
  const [isFull, setFull] = useState(false)
  const now = useNow(1_000)
  const src = useMemo(() => (feed ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(feed.svg)}` : ''), [feed])

  if (!feed) {
    return (
      <div className="mt-8 rounded-2xl border border-dashed p-10 text-center">
        <h2 className="font-display text-2xl font-semibold">Waiting for Mission Control…</h2>
        <p className="mx-auto mt-2 max-w-prose text-sm text-muted-foreground">
          This page comes from the mission-control-win mod. Run /mission in Claude Code and press ↗ Browser, or just work: it sends the live view here every couple of seconds while anything changes.
        </p>
      </div>
    )
  }

  const s = feed.summary
  const age = Math.max(0, Math.round((now - feed.at) / 1000))
  const changed = feed.files.filter(f => f.changed).length
  return (
    <main className="flex flex-col gap-5 pt-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-3xl font-semibold">Mission Control</h2>
          <p className="mt-1 text-sm text-muted-foreground">Turn {feed.turn}: what Claude and its subagents are doing, and the code it touches.</p>
        </div>
        <Badge variant="outline" className={age < 10 ? 'border-sage/50 text-sage' : 'text-muted-foreground'}>
          {age < 10 ? 'LIVE' : `last update ${age} s ago`}
        </Badge>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat icon={<Bot className="size-4" aria-hidden />} value={s.agents} label="agents" />
        <Stat value={s.running} label="running" accent={s.running > 0} />
        <Stat icon={<Wrench className="size-4" aria-hidden />} value={s.tools} label="tool calls" />
        <Stat value={s.failed} label="failed" warn={s.failed > 0} />
        <Stat icon={<FileCode2 className="size-4" aria-hidden />} value={changed} label="files changed" />
      </dl>

      <div className={`grid gap-5 ${isFull ? '' : 'xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]'}`}>
        {!isFull && (
          <section className="flex max-h-[720px] flex-col rounded-2xl border bg-card/60" aria-label="Who is doing what">
            <h3 className="border-b px-4 py-3 font-display text-lg font-semibold">Who</h3>
            <ol className="flex-1 overflow-y-auto px-2 py-2 font-mono text-[13px] leading-6">
              {feed.lines.length === 0 && <li className="px-2 text-muted-foreground">Nothing yet. Start a task and watch it fill in.</li>}
              {feed.lines.map((l, i) => (
                <li key={i} className={`flex items-baseline gap-1 rounded px-2 ${l.status === 'running' ? 'bg-primary/10' : ''}`}>
                  <span className="whitespace-pre text-muted-foreground">{l.prefix}</span>
                  <span
                    className={`truncate ${l.kind === 'tool' ? '' : 'font-semibold'} ${l.status === 'failed' ? 'text-destructive' : l.status === 'running' ? 'text-primary' : l.kind === 'tool' ? 'text-muted-foreground' : 'text-foreground'}`}
                    style={l.kind === 'tool' && l.status === 'done' ? { color: FAMILY[l.family] ? `${FAMILY[l.family]}cc` : undefined } : undefined}
                    title={l.text}
                  >
                    {l.text}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
        <section className="flex flex-col gap-3 rounded-2xl border bg-card/60 p-3" aria-label="Code map">
          <div className="flex items-center justify-between px-1">
            <h3 className="font-display text-lg font-semibold">Code map</h3>
            <Button variant="ghost" size="sm" onClick={() => setFull(f => !f)} aria-pressed={isFull}>
              {isFull ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
              {isFull ? 'Fit beside the tree' : 'Full width'}
            </Button>
          </div>
          <div className="overflow-auto rounded-xl bg-[#0d1015]">
            <img src={src} alt={`Code map of ${feed.files.length} files`} className="block h-auto w-full min-w-[720px]" />
          </div>
          {feed.files.length > 0 && (
            <ul className="grid gap-1 px-1 text-xs sm:grid-cols-2">
              {feed.files.map(f => (
                <li key={f.path} className="flex items-baseline gap-2 truncate" title={f.path}>
                  <span className={`shrink-0 rounded px-1 font-mono text-[10px] uppercase ${f.changed ? 'bg-sage/15 text-sage' : f.act === 'read' ? 'bg-[#5aa9ff]/15 text-[#5aa9ff]' : 'bg-secondary text-muted-foreground'}`}>{f.changed ? 'changed' : f.act}</span>
                  <span className="truncate font-mono">{f.path.split('/').slice(-2).join('/')}</span>
                  {f.why && <span className="truncate text-muted-foreground">· {f.why}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  )
}

function Stat({ value, label, icon, accent = false, warn = false }: { value: number; label: string; icon?: React.ReactNode; accent?: boolean; warn?: boolean }) {
  return (
    <div className="rounded-2xl border bg-card/60 px-4 py-3">
      <dd className={`flex items-center gap-2 font-display text-3xl font-semibold ${accent ? 'text-primary' : warn ? 'text-destructive' : ''}`}>
        {icon}
        {value}
      </dd>
      <dt className="text-xs text-muted-foreground">{label}</dt>
    </div>
  )
}
