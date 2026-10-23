<img src=".claude-plugin/icon.png" width="72" align="right" alt="">

# memory-status

For people who keep agent memory in a self-hosted Supabase. It tells you whether memory is up or degraded, and how many writes are waiting to be replayed.

## What it does

- **A line above the prompt:** `◉ memory ok`, `◉ memory degraded · kong down`, or `· 3 writes queued`.
- **`/memory-status`** shows:
  - the gateway's answer
  - every Supabase container and its status
  - the pending-write queue

  It gives one targeted fix, `compose up -d --no-deps` for only the critical services, with **Copy fix** and **Run fix**. Run fix asks for a second press before it runs.
- It checks every 30 s with an HTTP request to `<url>/rest/v1/`, `podman ps` (or `docker ps`) and a line count of the queue file. A gateway that answers 401 counts as up, because that means it is there and wants a key.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `url` | found | The Supabase gateway. Empty reads it from your `supabase-memory` MCP server, else `http://127.0.0.1:8100`. |
| `pendingFile` | found | The `pending.jsonl` that degraded-mode writes wait in. |
| `critical` | `supabase-kong,supabase-rest,supabase-db` | Any of these stopped means degraded. |
| `onlyProblems` | `false` | On hides the line while all is well. |
