import { ArrowUpRight, Copy, Pin, PinOff, Play } from 'lucide-react'
import { toast } from 'sonner'
import { motion, useReducedMotion } from 'motion/react'

import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Switch } from './components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip'
import { modHref, type ModRow } from './hub'

type Props = {
  mod: ModRow
  index: number
  pins: string[]
  isPending: boolean
  isLit: boolean
  isDetail?: boolean
  onToggle: (mod: ModRow, on: boolean) => void
  onRun: (command: string) => void
  onPin: (command: string) => void
  onHighlight: (id: string | null) => void
}

export function ModCard({ mod, index, pins, isPending, isLit, isDetail = false, onToggle, onRun, onPin, onHighlight }: Props) {
  const reduce = useReducedMotion()
  const commands = isDetail ? mod.commands : mod.commands.slice(0, 4)
  const hidden = mod.commands.length - commands.length

  return (
    <motion.article
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? undefined : { opacity: 0, y: -8 }}
      transition={{ duration: 0.32, delay: reduce ? 0 : Math.min(index, 12) * 0.035, ease: [0.2, 0.7, 0.2, 1] }}
      onMouseEnter={() => onHighlight(mod.id)}
      onMouseLeave={() => onHighlight(null)}
      onFocus={() => onHighlight(mod.id)}
      onBlur={() => onHighlight(null)}
      className={[
        'group relative flex flex-col gap-3 rounded-xl border bg-card/80 p-5 backdrop-blur-sm transition-[border-color,background-color,box-shadow] duration-200',
        mod.isSelf ? 'border-brass/60 ring-1 ring-brass/30' : '',
        isLit ? 'border-primary/70 shadow-[0_0_0_1px_var(--primary),0_12px_40px_-12px_oklch(0.78_0.13_70/0.45)]' : 'border-border',
        mod.enabled ? '' : 'bg-card/50',
      ].join(' ')}
    >
      {mod.isSelf && <p className="-mb-1 text-[11px] font-semibold tracking-[0.14em] text-brass uppercase">◈ This mod · the Mod Manager you are using</p>}
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className={`font-display text-xl leading-tight font-semibold ${mod.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>
            {isDetail ? (
              mod.name
            ) : (
              <a href={modHref(mod.id)} className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                {mod.name}
              </a>
            )}
          </h3>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            v{mod.version} · @{mod.marketplace}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isPending && (
            <Badge variant="outline" className="border-brass/50 text-brass">
              reload to apply
            </Badge>
          )}
          {mod.isSelf ? (
            <Badge variant="outline" className="border-brass/50 text-brass">
              always on
            </Badge>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-2">
                  <span className={`text-xs ${mod.enabled ? 'text-primary' : 'text-muted-foreground'}`}>{mod.enabled ? 'On' : 'Off'}</span>
                  <Switch checked={mod.enabled} onCheckedChange={on => onToggle(mod, on)} aria-label={`Turn ${mod.name} ${mod.enabled ? 'off' : 'on'}`} />
                </span>
              </TooltipTrigger>
              <TooltipContent>Takes effect after a reload</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      {mod.description && <p className={`text-sm leading-relaxed text-muted-foreground ${isDetail ? '' : 'line-clamp-3'}`}>{mod.description}</p>}

      <ul className="mt-auto flex flex-col gap-1.5">
        {commands.length === 0 && (
          <li className="text-sm text-muted-foreground italic">
            {mod.enabled ? 'No slash commands: it works by itself, above the prompt or in hooks.' : 'Off: its commands come back once it is on and reloaded.'}
          </li>
        )}
        {commands.map(c => {
          const isPinned = pins.includes(c.name)
          return (
            <li key={c.name} className="flex items-center gap-2">
              <Button size="sm" variant="secondary" className="font-mono text-primary" onClick={() => onRun(c.name)} aria-label={`Run /${c.name}`}>
                <Play className="size-3" aria-hidden />/{c.name}
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="icon-sm" variant="ghost" onClick={() => void copy(c.name)} aria-label={`Copy /${c.name}`}>
                    <Copy className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy /{c.name} to paste into the prompt</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="icon-sm" variant="ghost" onClick={() => onPin(c.name)} aria-label={isPinned ? `Unpin /${c.name} from the bar` : `Pin /${c.name} to the bar`} aria-pressed={isPinned}>
                    {isPinned ? <PinOff className="size-3.5 text-sage" /> : <Pin className="size-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isPinned ? 'Unpin from the bar above the prompt' : 'Pin to the bar above the prompt'}</TooltipContent>
              </Tooltip>
              <span className={`min-w-0 text-xs text-muted-foreground ${isDetail ? '' : 'truncate'}`}>{c.description}</span>
            </li>
          )
        })}
        {hidden > 0 && (
          <li>
            <a href={modHref(mod.id)} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              {hidden} more <ArrowUpRight className="size-3" aria-hidden />
            </a>
          </li>
        )}
      </ul>
    </motion.article>
  )
}

async function copy(name: string) {
  try {
    await navigator.clipboard.writeText(`/${name}`)
    toast.success(`Copied /${name}: paste it into the prompt`)
  } catch {
    toast.error(`Could not reach the clipboard. The command is /${name}`)
  }
}
