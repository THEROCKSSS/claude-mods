<img src=".claude-plugin/icon.png" width="72" align="right" alt="">

# port-watch

`/ports` answers "what is on 5173 again, and can my phone reach it?"

## What it does

For every listening port, it shows:
- who owns it: the project, named from the process's command line (including `python -m` modules), or the container
- where it is bound: loopback only, all interfaces, or the tailnet
- whether your phone can reach it

For a phone-reachable port you get its **Tailscale URL** and a **QR code** to scan. Tailscale Serve mappings are shown on the port they front.

- Filter chips: **Dev** (your projects and containers), **Phone ok**, **All**. There is a search box too.
- **Open** and **Copy** on each row.
- It rescans every 20 s while the pane is open, and does nothing while it is closed.

It reads, and never changes:
- `netstat`, `tasklist` and the process command lines on Windows; `lsof` and `ps` elsewhere
- `podman ps` and `docker ps` for published ports, which the OS does not list as the container's
- `tailscale ip -4` and `tailscale serve status`

The QR codes come from the vendored [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT; see [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)).

No settings.
