# Handoff

## State (2026-10-23)

Four mods, all validated and tested. See README for what each does and AGENTS.md for checks.

- **mod-hub 0.1.0** includes:
  - the bar panel above the prompt
  - the `/mod-manager` pane, with filters, sort, search, compact view, a Click Run/Copy switch, copy with a system-clipboard fallback, a "queued" notice mid-turn, and itself listed first and marked
  - the `/hub` web app: React 19, Tailwind 4, shadcn/ui, three.js via R3F, and Motion
  - the `mod-setup` skill
- **mod-logic 0.1.0** includes:
  - the analyzer, graph, and ring/sphere layout
  - live re-reads on Edit/Write inside a mod's folder, with drafts picked up from any `.claude-plugin/` folder
  - the pane's 2D Svg and breakdown
  - the hub's `#/logic` 2D/3D view
- **The forks:** blast-radius-win (fails closed, guards PowerShell) and mission-control-win (desktop Svg code map).
- **mod-catalog was dropped** at Owen's request.

## Known gaps

- mission-control-win: 2 of 9 tests fail, the same 2 as upstream on engine 2.1.308.
- The desktop session reports no surfaces, so blast-radius-win refuses risky commands outright instead of offering a Proceed button.
- `$.command.run` queues a command pressed mid-turn until the turn ends. The engine has no way past that; the mod says so with a toast.
- Desktop `$.ui.copy` has no clipboard path yet, so copying falls back to `clip`, `pbcopy` or `xclip`.

## Next

Polish list: see the session's report to Owen (labels in 3D, hub serving the graph without mod-logic open, and so on).
