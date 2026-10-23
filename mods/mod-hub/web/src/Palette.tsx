// ⌘K / Ctrl+K: every slash command Claude Code lists, grouped by where it comes from; Enter runs it.
import { RefreshCw, SquareTerminal } from 'lucide-react'

import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from './components/ui/command'
import type { HubState } from './hub'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: HubState
  onRun: (command: string) => void
  onReload: () => void
}

const SOURCE: Record<string, string> = { builtin: 'Claude Code', user: 'Your commands', mcp: 'MCP servers' }
const SEP = '␟' // between a command's name and its group, so two groups may list one name

// Whole-word ranking, not cmdk's fuzzy letters: a name that starts with the search beats one that holds
// it, which beats its mod's name, which beats its description. Anything else is hidden.
export function rank(value: string, search: string, keywords: string[] = []): number {
  const q = search.trim().toLowerCase().replace(/^\//, '')
  if (!q) return 1
  const name = (value.split(SEP)[0] ?? '').toLowerCase()
  if (name === q) return 1
  if (name.startsWith(q)) return 0.9
  if (name.includes(q)) return 0.75
  if ((keywords[0] ?? '').toLowerCase().includes(q)) return 0.5
  if (keywords.slice(1).some(k => k.toLowerCase().includes(q))) return 0.25
  return 0
}

export function Palette({ open, onOpenChange, state, onRun, onReload }: Props) {
  const mods = state.mods.filter(m => m.commands.length > 0)
  const others = Object.entries(
    state.otherCommands.reduce<Record<string, HubState['otherCommands']>>((acc, c) => ((acc[c.source] ??= []).push(c), acc), {}),
  )
  const run = (name: string) => {
    onOpenChange(false)
    onRun(name)
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Run a command" description="Every slash command in your session" filter={rank}>
      <CommandInput autoFocus placeholder="Run a command… mission, mod-logic, snake" />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty>No command matches.</CommandEmpty>
        <CommandGroup heading="Hub">
          <CommandItem
            value={`reload-plugins${SEP}hub`}
            keywords={['reload plugins']}
            onSelect={() => {
              onOpenChange(false)
              onReload()
            }}
          >
            <RefreshCw aria-hidden />
            Reload plugins
            {state.pending.length > 0 && <CommandShortcut>{state.pending.length} waiting</CommandShortcut>}
          </CommandItem>
        </CommandGroup>
        {mods.map(m => (
          <CommandGroup key={m.id} heading={m.name}>
            {m.commands.map(c => (
              <CommandItem key={`${m.id}/${c.name}`} value={`${c.name}${SEP}${m.id}`} keywords={[m.name, c.description]} onSelect={() => run(c.name)}>
                <SquareTerminal aria-hidden />
                <span className="font-mono">/{c.name}</span>
                <span className="truncate text-xs text-muted-foreground">{c.description}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        <CommandSeparator />
        {others.map(([source, list]) => (
          <CommandGroup key={source} heading={SOURCE[source] ?? source}>
            {list.map(c => (
              <CommandItem key={`${source}/${c.name}`} value={`${c.name}${SEP}${source}`} keywords={[SOURCE[source] ?? source, c.description]} onSelect={() => run(c.name)}>
                <span className="font-mono">/{c.name}</span>
                <span className="truncate text-xs text-muted-foreground">{c.description}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
