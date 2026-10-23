<img src=".claude-plugin/icon.png" width="72" align="right" alt="">

# mod-logic

`/mod-logic` reads every installed mod's source and draws how it works:
- the events it hooks
- the capabilities it calls, coloured by risk: runs programs, uses the network, writes files, drives Claude, and so on
- the commands, tools and state it registers

![The 3D logic graph in the Mod Hub](../../docs/screenshots/logic-3d.gif)

## What it does

- **A 2D map in the pane** shows a breakdown per mod. Parts that two or more mods share are where they meet.
- **Live:** edit a file inside a mod's folder and its part of the graph redraws within a second. Drafts in any `.claude-plugin/` folder are picked up too.
- **2D or 3D in the Mod Hub** (`#/logic`), with filters by kind and a focus on one mod.
- **It flags guards that fail open**: a hook that can throw without a `.catch`.

The analyzer, graph and layout live in `shared/logic.ts`, so the pane and the web app use the same code.

No settings.
