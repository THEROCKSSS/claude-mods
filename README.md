# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): a manager for all your mods, with a live web hub, and a live graph of how every mod works. Built and tested on Windows; the hub and the logic graph work anywhere Claude Code and Node run.

| Mod | What it does |
| --- | --- |
| **mod-hub** | A bar above the prompt with **⚙ Manage**, **◈ Hub**, a **prompt-cache countdown** ("◷ cache warm · 3:42 left", learns 5 min or 1 h) and your pinned commands. `/mod-manager` turns mods on and off, runs or copies their commands, pins them, and saves **presets**: named setups (mods on or off, pins, commands to run) you apply in one press. Claude can make presets for you through its `mod_presets` tool; only you apply them. `/hub` opens a web control room on `127.0.0.1:8796` with Mods, Presets, Logic graph and Mission pages. |
| **mod-logic** | `/mod-logic` reads every mod's source and shows how it works: the events it hooks, the capabilities it calls (coloured by risk: runs programs, uses the network, writes files, drives Claude…) and what it registers. A 2D map in the pane, and 2D or 3D in the hub. Live: edit a mod and its part of the graph redraws within a second. It also flags guards that fail open. |
| **blast-radius-win** | Windows fork of [hamzafer's blast-radius](https://github.com/hamzafer/claude-code-mods). Holds recursive deletes, force pushes and migrations from the Bash **and PowerShell** tools, shows what they would change, and blocks the command if the guard itself fails. |
| **mission-control-win** | Windows fork of hamzafer's mission-control. `/mission` opens the live map of agents and tool calls; `/mission code` draws a readable code map in the desktop app, and **↗ Browser** shows both full size on the hub's Mission page. |

## Install

Needs Claude Code with mods (2.1.29x or later) and, for the web hub, Node 18+.

```bash
claude plugin marketplace add THEROCKSSS/claude-mods
claude plugin install mod-hub@owen-mods
claude plugin install mod-logic@owen-mods
```

Then run `/reload-plugins` in Claude Code. Or ask your agent to *"install mod-hub from THEROCKSSS/claude-mods and set it up"*: mod-hub ships a `mod-setup` skill that walks it through installing, checking, and adding future mods.

On macOS or Linux, use hamzafer's original blast-radius and mission-control instead of the `-win` forks.

## Updating

After `claude plugin update` and `/reload-plugins`, a hub left running from the older version is shut down and replaced by itself, and mod-logic re-sends its graph to any hub that has not had it yet.

## How the hub stays safe

The web page never runs anything. It queues a request, and the mod checks it against what this session actually has installed before running it. The server listens on `127.0.0.1` only, and every API call needs a token that only the served page knows. It refuses foreign `Host` and `Origin` headers, so another website can't drive it, even through DNS rebinding.

## Why the Windows forks exist

Upstream was written on macOS, and on Windows two things break quietly:

- **blast-radius failed open.** Its hold loop runs `sleep`, which isn't on Windows' PATH. The call throws, a hook that throws with no `.catch` is skipped, and the risky command runs unchecked. The fork waits on `$.clock.sleep`, previews through Git Bash, guards PowerShell too, and fails closed.
- **mission-control's code map needed Chrome at a macOS path,** and only drew in a terminal. The fork draws it with the desktop app's own `Svg` element.

## Develop

Each mod lives in `mods/<name>/`. See [AGENTS.md](AGENTS.md) for the checks to run before a change is done.

```bash
claude plugin validate mods/mod-hub
claude plugin test mods/mod-hub
node --test mods/mod-hub/server/hub.test.mjs
cd mods/mod-hub/web && npm ci && npm run build   # writes mods/mod-hub/app
```

| Suite | Result |
| --- | --- |
| mod-hub | 16/16 |
| mod-logic | 5/5 |
| hub server | 10/10 |
| blast-radius-win | 20/20 |
| mission-control-win | 8/10. The same 2 tests fail on unmodified upstream with this engine (terminal PNG path, band order). |

## License

MIT. The forks keep Hamza Zafar's copyright; see [LICENSE](LICENSE).
