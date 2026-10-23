<img src=".claude-plugin/icon.png" width="72" align="right" alt="">

# mod-updates

It tells you when a mod you installed has a new version, and what changed.

## What it does

- **A bar line** shows `⬆ 2 mod updates` when any are waiting.
- **`/mod-updates`** lists each installed mod with:
  - your version and the newest
  - the commits since your install that touched that mod's folder

  **Update** runs `claude plugin update <id>` for one mod; **Update all** does them all. Reload afterwards.
- **Git marketplaces:** it runs `git fetch` in the marketplace clone, then reads the mod's `plugin.json` at the fetched ref and the `git log` for its folder. Nothing is checked out until you update.
- **Folder marketplaces** (a local path) compare against the folder's current version.
- It first checks 20 s after start, then on the schedule.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `everyHours` | `6` | How often it fetches. `0` checks only when you open `/mod-updates`. |
