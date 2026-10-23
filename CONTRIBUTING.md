# Contributing

Bug reports, mod ideas and pull requests are welcome. Questions and presets you want to share go in [Discussions](https://github.com/THEROCKSSS/claude-mods/discussions).

## If you are an agent

Load the `mod-setup` skill first (`mods/mod-hub/skills/mod-setup/SKILL.md`). [AGENTS.md](AGENTS.md) lists the checks to run. Both also apply to people.

## Layout

```
.claude-plugin/marketplace.json   the owen-mods marketplace: every mod, its version and category
mods/<name>/
  .claude-plugin/plugin.json      name, version, description, userConfig
  .claude-plugin/icon.png         512×512
  hooks/                          the mod: register.tsx plus the pure helpers it imports
  tests/                          `claude plugin test` suites
  README.md
mods/mod-hub/server/              the hub's Node server (no dependencies) and its tests
mods/mod-hub/web/                 the hub's React app; builds into mods/mod-hub/app (committed)
mods/*/shared/                    code both a pane and the web app use, with its own tsconfig
scripts/check-mods.mjs            validate and test every mod
```

## Making a change

1. Keep pure logic (parsing, sorting, judging) in its own file, apart from `register.tsx`, and test it there. The mod engine has rules that fail quietly:
   - Every function that receives `$` must sit at the top level of the file.
   - A hook that throws without a `.catch` is skipped, so a guard that throws fails open.
   - `types/index.d.ts` must not import anything.
2. Run the checks:

   ```bash
   node scripts/check-mods.mjs            # validate + test every mod
   node --test mods/mod-hub/server/hub.test.mjs
   cd mods/mod-hub/web && npm ci && npm run build
   ```

   In the Claude desktop app, set `CLAUDE_BIN="$CLAUDE_CODE_EXECPATH"` so the checks use the binary that runs your session.
3. If you touched the web app, commit the rebuilt `mods/mod-hub/app/`. Then open `/hub` and use the view you changed.
4. Bump the mod's version in both `plugin.json` and `marketplace.json`. Add a line to [CHANGELOG.md](CHANGELOG.md).

## Style

- Comments say why, not what.
- Names are plain words.
- UI is dark, labels data as LIVE DATA or NON-LIVE DATA, never shows a blank area without saying why, and never uses `transition: all`.

## Forks

`blast-radius-win` and `mission-control-win` fork [hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods) under MIT. Keep upstream's copyright in [LICENSE](LICENSE). Fixes that are not Windows-specific belong upstream too.
