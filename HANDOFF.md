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

## Since the first push (2026-10-23)

- **Live run:** the real hub was exercised against a live session. State came in, an edit came through mod-logic into the hub's graph, and a pin set on the web reached the session in about 1 s.
- **Two bugs fixed.** A hub left running across an update kept serving the old API, so the server is now versioned and mod-hub replaces an old one. The graph never reached a hub opened after the session started, so mod-logic now resends every 10 s to a hub that has not had it.
- **Both panels redesigned:** title typography, a status or risk SVG strip, a toolbar card, cards that light on hover, and pill badges.

## Presets, cache timer, Mission page (2026-10-23)

- **mod-hub 0.2.0** adds:
  - **Presets:** they live in `shared/presets.ts`. The pane has a Presets tab, the hub a `#/presets` page, and Claude a `mod_presets` tool (list, save and delete; never apply).
  - **Applying a preset that flips mods:** it reloads first, and the owed commands run 1.5 s after `session.start`, from `pendingApply` in the store.
  - **The cache countdown in the bar and the hub header:** fed by `turn.step` usage. It learns a 1 h lifetime when a request more than 5 min after the last still reads the cache.
  - **The Mission feed:** the server is version 3 and accepts `POST /api/mission`.
- **mission-control-win 0.1.3-win.2:** the desktop map is drawn at the pane's own size, with a ↗ Browser button. It pushes its tree and a 1400×860 map to the hub every 2 s when something changed.

## Three new mods, hub resilience, GitHub polish (2026-10-23, v0.3.0)

- **New mods:**
  - port-watch 0.1.0 (`/ports`, with QR codes from vendored qrcode-generator)
  - memory-status 0.1.0
  - mod-updates 0.1.0
  
  Install them with `claude plugin install <name>@owen-mods`, then `/reload-plugins`.
- **Hub resilience (mod-hub 0.2.1).** The live hub (pid 4484) died once with nothing logged, and the SSE-disconnect theory did not reproduce (there is a test for it). So the hub now:
  - writes `~/.claude/mod-hub/hub.log`
  - starts through WMI on Windows (its parent is WmiPrvSE, outside the app's tree)
  - is restarted by mod-hub at most once a minute after going away

  If it dies again, read hub.log first.
- **Demo.** `npm run build:demo` puts the snapshot `web/src/demo-data.json` behind a NON-LIVE DATA banner. Buttons only toast. The `pages.yml` workflow publishes it.
  - Regenerating the snapshot needs a running hub. The generator scripts lived in the session scratchpad and are not in the repo.
  - The snapshot keeps builtin commands only, strips absolute paths, and the CI greps the built demo for private paths.
- **Screenshots** are in `docs/screenshots`.
  - Headless Chrome cannot draw the 3D logic canvas, though the home constellation works. `logic-3d.gif` was recorded from the in-app browser pane instead.
  - A fresh Chrome profile shows the 2D view, because the 2D/3D choice is stored in localStorage.
- **Repo files added:**
  - CI (`ci.yml`): the hub server on Ubuntu and Windows, the web build plus the demo build, and `scripts/check-mods.mjs` on both OSes with npm `@anthropic-ai/claude-code@2.1.309`
  - Dependabot
  - issue templates (bug and mod idea, with the Model/Harness/Agent header) and a PR template
  - CONTRIBUTING, SECURITY, CHANGELOG and THIRD_PARTY_NOTICES
- **Social preview:** `docs/social-preview.png` is 1280×640. GitHub has no API for it, so it is uploaded by hand under Settings → General → Social preview.

## Known gaps

- mission-control-win: 2 of 9 tests fail, the same 2 as upstream on engine 2.1.308.
- The desktop session reports no surfaces, so blast-radius-win refuses risky commands outright instead of offering a Proceed button.
- `$.command.run` queues a command pressed mid-turn until the turn ends. The engine has no way past that; the mod says so with a toast.
- Desktop `$.ui.copy` has no clipboard path yet, so copying falls back to `clip`, `pbcopy` or `xclip`.

## Next

Polish list: see the session's report to Owen (labels in 3D, hub serving the graph without mod-logic open, and so on).
