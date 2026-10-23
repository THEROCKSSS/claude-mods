Model: <!-- the model that wrote this, if an agent did; else delete this header -->
Harness: <!-- Claude Code CLI, desktop app, ... -->
Agent: <!-- the agent's name, if one did -->

## Problem

<!-- What this fixes or adds, with the evidence: the message you saw, a count, a screenshot. Link the issue. -->

## What changed

<!-- The mechanism, in a few lines. Which mods, which shared files (mods/mod-hub/shared, mods/mod-logic/shared). -->

## Checks

<!-- Paste the real output. `node scripts/check-mods.mjs` runs the first two for every mod. -->

- [ ] `claude plugin validate mods/<name>` passes for every touched mod
- [ ] `claude plugin test mods/<name>` passes (mission-control-win: 2 known upstream failures)
- [ ] `node --test mods/mod-hub/server/hub.test.mjs`, if the server changed
- [ ] `npm run build` in `mods/mod-hub/web`, with `mods/mod-hub/app` committed, if the web app changed
- [ ] Bumped the mod's version in its `plugin.json` and in `.claude-plugin/marketplace.json`, and added a CHANGELOG line

## Not verified

<!-- Anything you could not check, and why. "Nothing" is a fine answer if it is true. -->
