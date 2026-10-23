---
name: mod-setup
description: Set up Claude Code mods from the owen-mods marketplace. Use when installing mod-hub on a new machine, when the person installs or writes another mod, or when a mod is missing from the Mod Hub, the bar above the prompt, or /mod-logic.
---

# Mod setup

Mods are Claude Code plugins with a hooks module (`hooks/hooks.json` naming `register.tsx`). mod-hub finds every installed plugin by itself: it reads `~/.claude/plugins/installed_plugins.json`, the session's command list and `enabledPlugins`. A new mod never needs registering with the hub. It needs installing, then a reload.

## Install on a new machine

1. **Check the host.** Run `claude --version`. Mods need a build from 2.1.29x or later. In the Claude desktop app, the bundled build runs the session, and `CLAUDE_CODE_EXECPATH` names it. An older `claude` on PATH lists every mod as "failed to load", so run plugin commands with the binary that runs the session. The web hub needs Node 18+ (`node --version`).
   *Done when* both versions are known and adequate.
2. **Add the marketplace.** Run `claude plugin marketplace add THEROCKSSS/claude-mods`, or the folder path for a local checkout.
3. **Install.** Run `claude plugin install mod-hub@owen-mods`. Add others the person wants: `mod-logic`, `mission-control-win`, `blast-radius-win` (Windows forks; on macOS or Linux use hamzafer/claude-code-mods' originals instead).
4. **Load.** Ask the person to run `/reload-plugins`. Only they can run slash commands.
5. **Verify.** Run `claude plugin list --json`. Every installed mod shows `enabled: true` and no `errors`. Then the person sees `⚙ Mods  ◈ Hub` above the prompt, and `/hub` opens `http://127.0.0.1:8796/` with **LIVE DATA**.
   *Done when* the list shows no errors and the person confirms the bar and the hub.

## When the person installs another mod

1. Install it with the session's binary (`claude plugin install <name>@<marketplace>`; add the marketplace first if it is new).
2. The person runs `/reload-plugins`.
3. Within 15 s the mod appears in the hub, in `/mod-manager` and in `/mod-logic`. Its commands get Run and Pin buttons. A mod with no commands still gets its On/Off switch.
   *Done when* the mod shows in `/mod-manager` with its commands. If it shows with none and it has some, its hooks module failed to load: check `claude plugin list --json` for its `errors`.

Read a third-party mod's hooks module before installing it. It runs with the person's permissions. Look for `$.process.run`, `$.http.fetch`, `$.fs.write` and what each reaches.

## Writing a new mod into this marketplace

1. Make `mods/<name>/` with `.claude-plugin/plugin.json` (`name`, `version`, `description`), `hooks/hooks.json` (`{ "modules": ["./register.tsx"] }`) and `hooks/register.tsx`. Load the `plugin-authoring` skill for the API. The engine writes the full types file each session.
2. Add an entry to `.claude-plugin/marketplace.json` with `"source": "./mods/<name>"`.
3. Run `claude plugin validate mods/<name>`, then `claude plugin test mods/<name>` (tests in `mods/<name>/tests/*.test.ts`).
4. Install it as above. A folder marketplace is read straight from disk, so later edits only need `/reload-plugins`.
   *Done when* validate passes, the tests pass, and the mod appears in the hub.

Engine rules that fail silently on Windows:

- **Fail-open hooks.** A hook that throws is skipped, and the call it guarded goes ahead. Give every guard `.catch(failClosed)`, with the handler declared at the top level of the file.
- **Top-level `$`.** A function that receives `$` must be declared at the top level of the module, or the module does not load.
- **Missing tools.** `sleep`, `grep`, `ps`, `tail` and `lsof` are not on Windows' PATH, and `bash` there is WSL's. Use `$.clock.sleep`, `$.fs` and `$.http` instead. Run Git Bash by its absolute path (`C:/Program Files/Git/bin/bash.exe`) when a shell is unavoidable.
- **Backslash paths.** `$.fs` hands paths to the layer below with backslashes. Tests that compare paths should normalize them.

## Presets

When the person asks for a preset ("a preset for streaming", "save my setup"), use the `mod_presets` tool:

1. Run `list` first, for the plugin ids, each mod's commands (toggles are marked) and the recent commands.
2. Then `save` with a name, a one-line note, `mods` (only the ones to change, as id → on/off), `steps` (commands in order; toggles `enabled: false` unless asked) and `pins` if they asked for pins.
3. Tell them it's under ★ Presets in `/mod-manager` and on the hub. They apply it; you never do.

*Done when* `list` shows the new preset with the summary you meant.

## Mod Hub internals (for changes to mod-hub itself)

- `server/hub.mjs` serves `app/` and queues actions. It never runs anything. The mod polls `/api/actions`, checks each action against what is installed, and runs it. Keep the token, Host and Origin checks: `node --test server/hub.test.mjs`.
- `web/` is the React app (Vite, Tailwind 4, shadcn/ui, three.js via @react-three/fiber, Motion). `npm run build` in `web/` writes `app/`. Commit `app/` so installers need no build.
- Settings: `/plugin configure mod-hub@owen-mods` changes `port` (default 8796) and `showBar`.
