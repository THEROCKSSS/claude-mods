# Changelog

Versions are per mod, as in each `plugin.json` and `.claude-plugin/marketplace.json`. Repository releases (`v0.x.y` tags) bundle whatever mod versions were current.

## v0.3.0 (2026-10-23)

### New mods

- **port-watch 0.1.0.** `/ports` lists every listening port, the project or container that owns it, where it is bound, and its Tailscale URL with a QR code for your phone. You can filter by Dev, Phone ok or All. It reads Podman and Docker published ports and Tailscale Serve mappings.
- **memory-status 0.1.0.** A bar line says whether self-hosted Supabase memory is up, which containers are down, and how many writes wait in the local queue. `/memory-status` shows each container, with **Copy fix** and **Run fix** (`compose up -d --no-deps` for the critical services only).
- **mod-updates 0.1.0.** Spots new versions of installed mods in git and folder marketplaces, shows the commits since your install, and updates one or all with `claude plugin update`. It checks 20 s after start, then every 6 h (configurable).

### mod-hub 0.2.1

- The hub writes `~/.claude/mod-hub/hub.log`: start, exit code, signals and crashes, so a hub that stopped says why.
- On Windows the hub starts through WMI, outside the app's process tree, so closing a window cannot take it down with it.
- A hub that was up and disappears is started again, at most once a minute, with a toast.
- `npm run build:demo` builds the web app with a saved snapshot and a **NON-LIVE DATA** banner, for the GitHub Pages demo. The normal build leaves the snapshot out.

### Repository

- Each mod has an icon and a README.
- Screenshots and a GIF.
- CI on Windows and Ubuntu: hub server tests, a web build, and validating and testing every mod.
- A Pages demo.
- Dependabot.
- Issue and PR templates.
- CONTRIBUTING, SECURITY and THIRD_PARTY_NOTICES.

## v0.2.0 (2026-10-23)

- **mod-hub 0.2.0**
  - presets in the pane, the hub and Claude's `mod_presets` tool (Claude can save presets, but only you apply them)
  - a prompt-cache countdown in the bar and the hub header
  - the hub's Mission page
- **mission-control-win 0.1.3-win.2**
  - the desktop map is drawn at the pane's size
  - a ↗ Browser button opens the map full size in the hub

## v0.1.0 (2026-10-23)

- **mod-hub 0.1.0**
  - the bar
  - `/mod-manager` with filters, sort, search, run, copy and pins
  - `/hub`, the web control room (React, shadcn/ui, three.js)
  - the `mod-setup` skill for agents
- **mod-logic 0.1.0**: a live 2D/3D graph of every mod's hooks, capabilities and registrations
- **blast-radius-win 0.2.3-win.1**: fails closed and guards PowerShell
- **mission-control-win 0.1.3-win.1**: draws its code map with the desktop app's Svg element
