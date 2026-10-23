<img src=".claude-plugin/icon.png" width="72" align="right" alt="">

# mission-control-win

A Windows fork of [hamzafer's mission-control](https://github.com/hamzafer/claude-code-mods). `/mission` opens a live map of:
- the main agent
- its subagents
- every tool call, with its status

`/mission code` draws a map of the files this session touched, with each file's imports.

![Mission page in the Mod Hub](../../docs/screenshots/mission.png)

## Why a fork

Upstream drew its code map by running Chrome from a macOS path, and only into a terminal. This fork draws the map with the desktop app's own `Svg` element, sized to the pane.

**↗ Browser** sends the tree and a 1400×860 map to the Mod Hub's Mission page, which is easier to read full size. It re-sends every 2 s when something changed.

## Known gaps

2 of its 10 tests fail, the same 2 that fail on unmodified upstream with this engine (a terminal PNG path, and band order).

MIT. Upstream's copyright is kept in [LICENSE](../../LICENSE). On macOS or Linux, use the original.
