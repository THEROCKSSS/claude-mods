# Agents working in this repo

This is a Claude Code plugin marketplace (`owen-mods`). Each mod lives in `mods/<name>/`, and `.claude-plugin/marketplace.json` lists them.

**Setting up, installing, or writing a mod:** load the `mod-setup` skill (`mods/mod-hub/skills/mod-setup/SKILL.md`). It ships with mod-hub, so it is available wherever mod-hub is installed.

Shared code sits outside `hooks/`, each folder with its own small `tsconfig.json`, so the web app's Vite build can import it:

- `mods/mod-hub/shared/view.ts` holds the mod list's filters, sort and search. Both the `/mod-manager` pane and the hub app use it.
- `mods/mod-logic/shared/logic.ts` holds the source analyzer, the graph and the 2D/3D layout. The `/mod-logic` pane and the hub's `#/logic` view use it.

Change behaviour there once, not in each view.

Checks before a change is done:

- Every touched mod: `claude plugin validate mods/<name>` and `claude plugin test mods/<name>`, run with the binary that runs the session (`$CLAUDE_CODE_EXECPATH` in the desktop app).
- `mods/mod-hub/server`: `node --test server/hub.test.mjs`.
- `mods/mod-hub/web`: `npm run build` (typecheck plus build into `../app`; commit `app/`), then open the hub and exercise the changed view.

`mods/blast-radius-win` and `mods/mission-control-win` are MIT forks of hamzafer/claude-code-mods. Keep the upstream copyright in `LICENSE`.
