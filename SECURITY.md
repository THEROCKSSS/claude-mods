# Security

These mods run inside Claude Code with your permissions. Some can run programs, and the hub serves a page on your machine. A hole here is a hole in your machine, so please report one privately.

## Reporting

Use [a private security advisory](https://github.com/THEROCKSSS/claude-mods/security/advisories/new), not a public issue. Include the mod and version, what an attacker could do, and how to reproduce it. You will get a reply within a week.

## What is in scope

- **The Mod Hub server** (`mods/mod-hub/server/hub.mjs`). It listens on `127.0.0.1:8796` only. Every `/api` call except `/api/ping` needs a per-start token that only the served page knows. A foreign `Host` gets 421, which stops DNS rebinding, and a foreign `Origin` gets 403. The page can only queue a fixed set of action shapes, and the mod checks each one again against what is installed before acting. Any way around these checks is a bug, as is a way to reach files outside `mods/mod-hub/app`.
- **Commands the mods run.**
  - memory-status's **Run fix** runs `compose up -d --no-deps` for the services you named.
  - mod-updates runs `git fetch` in marketplace clones and `claude plugin update <id>`.
  - port-watch runs `netstat`, `tasklist` or `lsof`, plus `podman`, `docker` and `tailscale`, read-only.
  - A way to make any of these run something else is in scope.
- **blast-radius-win failing open.** A risky command that gets past the guard because the guard errored is a bug.

## What is not

- Anything that needs someone who can already run code as you.
- The NON-LIVE DATA Pages demo. It is static and talks to nothing.
