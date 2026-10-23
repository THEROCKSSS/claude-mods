// #/presets: named setups. Apply one to switch mods on or off, set the pins and run its commands;
// save the current setup as a new one; edit, duplicate or delete. Claude can make them too (its
// mod_presets tool); applying is always a press here or in the Mod Manager.
import { ArrowDown, ArrowUp, Copy, Pencil, Play, Plus, Sparkles, Star, Trash2, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useMemo, useState } from 'react'

import { isToggle, plan, summary, type Preset } from '../../shared/presets'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Checkbox } from './components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './components/ui/dialog'
import { Input } from './components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from './components/ui/select'
import { Textarea } from './components/ui/textarea'
import type { Action, HubState } from './hub'

type Props = { state: HubState; act: (a: Action, said: string) => Promise<void> }

export function Presets({ state, act }: Props) {
  const reduce = useReducedMotion()
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<Preset | null>(null)
  const [doomed, setDoomed] = useState<string | null>(null)
  const others = state.mods.filter(m => !m.isSelf)

  const save = () => {
    if (!name.trim()) return
    void act({ type: 'preset-snapshot', name: name.trim() }, `Saving "${name.trim()}"`)
    setName('')
  }

  return (
    <main className="flex flex-col gap-6 pt-8">
      <div>
        <h2 className="font-display text-3xl font-semibold">Presets</h2>
        <p className="mt-1 text-sm text-muted-foreground">A setup you like, one press away: which mods are on, what is pinned, and the commands to run.</p>
      </div>

      <section className="flex flex-col gap-3 rounded-2xl border border-primary/40 bg-card/60 p-5">
        <div className="flex items-center gap-2">
          <Star className="size-4 text-primary" aria-hidden />
          <h3 className="font-display text-lg font-semibold">Save your current setup</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Keeps every mod&apos;s on or off, your {state.pins.length} pin{state.pins.length === 1 ? '' : 's'}, and the commands you ran lately
          {state.recent.length ? ': ' : ' (none yet).'}
          {state.recent.slice(0, 6).map((r, i) => (
            <code key={`${r.command}-${i}`} className="mx-0.5 rounded bg-secondary px-1 font-mono text-xs text-primary">
              /{r.command}
              {r.args ? ` ${r.args}` : ''}
            </code>
          ))}
          . Commands that switch something on and off go in unticked, so applying twice never undoes itself.
        </p>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={e => {
            e.preventDefault()
            save()
          }}
        >
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name it: Focus, Streaming, Everything on…" className="max-w-sm" aria-label="New preset name" />
          <Button type="submit" disabled={!name.trim()}>
            <Star aria-hidden /> Save current setup
          </Button>
        </form>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3.5" aria-hidden /> Or ask Claude: &ldquo;make me a preset for streaming with snake off&rdquo;. It saves presets; only you apply them.
        </p>
      </section>

      {state.presets.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">No presets yet. Save your current setup above.</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <AnimatePresence mode="popLayout">
            {state.presets.map((p, i) => {
              const { flips, steps, missing } = plan(p, others)
              return (
                <motion.article
                  key={p.id}
                  layout={!reduce}
                  initial={reduce ? false : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? undefined : { opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.28, delay: reduce ? 0 : Math.min(i, 8) * 0.04 }}
                  className="flex flex-col gap-3 rounded-2xl border bg-card/80 p-5 transition-[border-color] hover:border-primary/60"
                >
                  <header className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-display text-xl font-semibold">{p.name}</h3>
                      {p.note && <p className="text-sm text-muted-foreground">{p.note}</p>}
                    </div>
                    {p.by === 'claude' && (
                      <Badge variant="outline" className="shrink-0 border-sage/50 text-sage">
                        <Sparkles aria-hidden /> by Claude
                      </Badge>
                    )}
                  </header>
                  <p className="text-sm">{summary(p)}</p>
                  <p className="text-xs text-muted-foreground">
                    {flips.length || steps.length || p.pins
                      ? `Applying now: ${[flips.length ? `${flips.length} mod${flips.length === 1 ? '' : 's'} switch (then a reload)` : '', steps.length ? `${steps.length} command${steps.length === 1 ? '' : 's'} run` : '', p.pins ? 'pins set' : ''].filter(Boolean).join(', ')}.`
                      : 'Applying now changes nothing: it all matches already.'}
                    {missing.length ? ` ${missing.length} of its mods are not installed here.` : ''}
                  </p>
                  <div className="mt-auto flex flex-wrap items-center gap-2">
                    <Button onClick={() => void act({ type: 'preset-apply', id: p.id }, `Applying ${p.name}`)}>
                      <Play aria-hidden /> Apply
                    </Button>
                    <Button variant="outline" onClick={() => setEditing(structuredClone(p))}>
                      <Pencil aria-hidden /> Edit
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Duplicate ${p.name}`} onClick={() => void act({ type: 'preset-save', preset: { ...p, id: '', name: `${p.name} copy`, by: 'you' } }, `Duplicated ${p.name}`)}>
                      <Copy aria-hidden />
                    </Button>
                    {doomed === p.id ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          void act({ type: 'preset-delete', id: p.id }, `Deleted ${p.name}`)
                          setDoomed(null)
                        }}
                        onBlur={() => setDoomed(null)}
                      >
                        Delete for good
                      </Button>
                    ) : (
                      <Button variant="ghost" size="icon" aria-label={`Delete ${p.name}`} onClick={() => setDoomed(p.id)}>
                        <Trash2 aria-hidden />
                      </Button>
                    )}
                  </div>
                </motion.article>
              )
            })}
          </AnimatePresence>
        </div>
      )}

      {editing && <Editor key={editing.id} preset={editing} state={state} onClose={() => setEditing(null)} onSave={p => void act({ type: 'preset-save', preset: p }, `Saved ${p.name}`).then(() => setEditing(null))} />}
    </main>
  )
}

function Editor({ preset, state, onClose, onSave }: { preset: Preset; state: HubState; onClose: () => void; onSave: (p: Preset) => void }) {
  const [p, setP] = useState(preset)
  const [pick, setPick] = useState('')
  const [args, setArgs] = useState('')
  const describe = useMemo(() => new Map(state.mods.flatMap(m => m.commands.map(c => [c.name, c.description] as const))), [state.mods])
  const all = useMemo(
    () => [
      ...state.mods.filter(m => m.commands.length).map(m => ({ group: m.name, commands: m.commands })),
      { group: 'Claude Code and yours', commands: state.otherCommands.filter(c => c.source !== 'mcp').slice(0, 80) },
    ],
    [state.mods, state.otherCommands],
  )
  const setMod = (id: string, v: 'on' | 'off' | null) =>
    setP(x => {
      const mods = { ...x.mods }
      if (v) mods[id] = v
      else delete mods[id]
      return { ...x, mods }
    })
  const move = (i: number, to: number) =>
    setP(x => {
      const steps = [...x.steps]
      const [one] = steps.splice(i, 1)
      steps.splice(Math.max(0, Math.min(steps.length, to)), 0, one!)
      return { ...x, steps }
    })
  const add = () => {
    if (!pick) return
    setP(x => ({ ...x, steps: [...x.steps, { command: pick, args: args.trim(), enabled: !isToggle(describe.get(pick) ?? '') }].slice(0, 20) }))
    setPick('')
    setArgs('')
  }

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Edit preset</DialogTitle>
          <DialogDescription>Changes are saved when you press Save. Applying stays a separate press.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Input value={p.name} onChange={e => setP({ ...p, name: e.target.value })} aria-label="Name" placeholder="Name" />
          <Textarea value={p.note} onChange={e => setP({ ...p, note: e.target.value })} aria-label="Note" placeholder="What it is for (optional)" rows={2} />
        </div>

        <section className="grid gap-2">
          <h4 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Mods · leave, or switch on or off when applied</h4>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {state.mods
              .filter(m => !m.isSelf)
              .map(m => {
                const want = p.mods[m.id]
                return (
                  <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5">
                    <span className={`truncate text-sm ${want ? 'font-medium' : 'text-muted-foreground'}`} title={m.id}>
                      {m.name}
                      <span className="ml-1.5 text-xs text-muted-foreground">{m.enabled ? 'now on' : 'now off'}</span>
                    </span>
                    <div className="flex shrink-0 rounded-md border p-0.5" role="group" aria-label={`${m.name} when applied`}>
                      {([null, 'on', 'off'] as const).map(v => (
                        <button
                          key={String(v)}
                          type="button"
                          aria-pressed={(want ?? null) === v}
                          onClick={() => setMod(m.id, v)}
                          className={`rounded px-2 py-0.5 text-xs transition-[background-color,color] ${(want ?? null) === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                          {v === null ? 'Leave' : v === 'on' ? 'On' : 'Off'}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
          </div>
        </section>

        <section className="grid gap-2">
          <h4 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Commands · run in order when applied</h4>
          {p.steps.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
          <ul className="grid gap-1.5">
            {p.steps.map((s, i) => {
              const toggleLike = isToggle(describe.get(s.command) ?? '')
              return (
                <li key={`${s.command}-${i}`} className="flex items-center gap-2 rounded-lg border px-3 py-1.5">
                  <Checkbox checked={s.enabled} onCheckedChange={v => setP(x => ({ ...x, steps: x.steps.map((y, j) => (j === i ? { ...y, enabled: v === true } : y)) }))} aria-label={`Run /${s.command}`} />
                  <code className={`flex-1 truncate font-mono text-sm ${s.enabled ? 'text-primary' : 'text-muted-foreground'}`}>
                    /{s.command}
                    {s.args ? ` ${s.args}` : ''}
                  </code>
                  {toggleLike && (
                    <Badge variant="outline" className="border-brass/50 text-brass" title="Runs a toggle: applying twice flips it back">
                      ⇄ toggle
                    </Badge>
                  )}
                  <Button variant="ghost" size="icon-sm" aria-label="Move up" onClick={() => move(i, i - 1)} disabled={i === 0}>
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Move down" onClick={() => move(i, i + 1)} disabled={i === p.steps.length - 1}>
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove /${s.command}`} onClick={() => setP(x => ({ ...x, steps: x.steps.filter((_, j) => j !== i) }))}>
                    <X aria-hidden />
                  </Button>
                </li>
              )
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Select value={pick} onValueChange={setPick}>
              <SelectTrigger className="w-56" aria-label="Command to add">
                <SelectValue placeholder="Add a command…" />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                {all.map(g => (
                  <SelectGroup key={g.group}>
                    <SelectLabel>{g.group}</SelectLabel>
                    {g.commands.map(c => (
                      <SelectItem key={`${g.group}/${c.name}`} value={c.name}>
                        /{c.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <Input value={args} onChange={e => setArgs(e.target.value)} placeholder="arguments (optional), e.g. setup" className="w-56" aria-label="Arguments" />
            <Button variant="secondary" onClick={add} disabled={!pick}>
              <Plus aria-hidden /> Add
            </Button>
          </div>
          {state.recent.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Recent:</span>
              {state.recent.slice(0, 8).map((r, i) => (
                <Button
                  key={`${r.command}-${r.args}-${i}`}
                  size="xs"
                  variant="outline"
                  className="font-mono"
                  onClick={() => setP(x => ({ ...x, steps: [...x.steps, { command: r.command, args: r.args, enabled: !isToggle(describe.get(r.command) ?? '') }].slice(0, 20) }))}
                >
                  + /{r.command}
                  {r.args ? ` ${r.args}` : ''}
                </Button>
              ))}
            </div>
          )}
        </section>

        <section className="grid gap-2">
          <h4 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Pins on the bar</h4>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={p.pins === null ? 'default' : 'outline'} onClick={() => setP({ ...p, pins: null })}>
              Leave as they are
            </Button>
            <Button size="sm" variant={p.pins !== null ? 'default' : 'outline'} onClick={() => setP({ ...p, pins: [...state.pins] })}>
              Use my current pins ({state.pins.length})
            </Button>
            {p.pins !== null && <span className="self-center font-mono text-xs text-muted-foreground">{p.pins.length ? p.pins.map(x => `/${x}`).join(' ') : 'clears the pins'}</span>}
          </div>
        </section>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave(p)} disabled={!p.name.trim()}>
            Save preset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
