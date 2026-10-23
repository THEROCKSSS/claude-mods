<img src=".claude-plugin/icon.png" width="72" align="right" alt="">

# mod-hub

The mod manager. You get three things:
- a bar above the prompt
- a `/mod-manager` pane
- `/hub`, a live web control room on `127.0.0.1:8796`

![The Mod Hub web app](../../docs/screenshots/hub.png)

## What it does

- **The bar** holds **⚙ Mods**, **◈ Hub**, your pinned commands and a prompt-cache countdown ("◷ cache warm · 3:42 left"). The countdown learns whether your cache lasts 5 minutes or an hour.
- **`/mod-manager`** lets you:
  - turn any mod on or off
  - run or copy its commands, and pin them to the bar
  - filter by on, off, pinned or new, and search
  
  It lists itself first, marked.
- **Presets** are named setups: which mods are on, which commands are pinned, and commands to run. Apply one in a press, or snapshot what you have now. Claude can save presets for you through its `mod_presets` tool, but only you can apply one.
- **`/hub`** opens the web app. It has four views:
  - **Mods:** a 3D constellation of your mods, plus the same controls as the pane
  - **Presets**
  - **Logic graph:** needs mod-logic
  - **Mission:** needs mission-control-win

  Ctrl K opens a command palette.
- **The `mod-setup` skill** teaches an agent to install, check and add mods in this marketplace.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `port` | `8796` | The local port the web app listens on. |
| `showBar` | `true` | Off hides the bar; `/mod-manager` and `/hub` still work. |
| `cacheTtl` | `auto` | `5m` or `1h` fixes the countdown's lifetime instead of learning it. |

## How it stays safe

The page never runs anything itself. It queues one of a fixed set of actions, and the mod checks each one against what this session has installed. The server listens on 127.0.0.1 only and needs a token only the served page knows. It refuses foreign `Host` and `Origin` headers. See [SECURITY.md](../../SECURITY.md).

The server writes `~/.claude/mod-hub/hub.log`, so a hub that stopped says why. A hub that disappears is started again, at most once a minute.

## Develop

```bash
node --test server/hub.test.mjs
cd web && npm ci && npm run build        # writes ../app, which is committed
npm run build:demo                       # the NON-LIVE DATA Pages demo, into web/dist-demo
```
