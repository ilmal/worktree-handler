# 🛰️ Worktree Handler

An always-on dashboard that watches the folder it lives in (`../`), discovers
every git worktree there, and runs **one SvelteKit dev
server per worktree** on stable, non-colliding ports — with one-click monitor /
start / stop / restart / open and live logs.

The dashboard updates over a **WebSocket** and patches in place (no full-page
refresh, so text stays selectable). Each card has:
- **Open ↗** links that point at the machine's **LAN IP** (e.g.
  `192.168.1.x`), not `localhost`, so you can open servers from other devices.
- A **PR → \<base\>** button that opens GitHub's "create PR" compare view against
  the branch this worktree is **based on** (auto-detected: the default branch,
  or the branch you stacked on top of).
- A **branch name you can click to copy** (works over plain-http LAN access too).
- A **✓ in main** badge when the branch's PR was actually merged into main
  (from the GitHub PR's merge state — a fresh branch with no merged PR is *not*
  marked merged). Refreshed ~every 60s.
- A **PR #N** badge for branches with an open PR, plus its **CI status**
  (`CI ✓` passing / `CI ✗` failing / `CI ⏳` pending) from GitHub check runs.
- A **⚠ conflicts with main** badge when the branch and main would conflict, or
  **✓ no conflicts** when they merge cleanly. Computed every ~3 min with
  `git merge-tree` (an in-memory 3-way merge — no working-tree changes), after
  refreshing main. So before you press **Merge main** you know if it's safe;
  conflicts also turn the button red.
- A **⤓ Merge main** button that fetches main (over HTTPS using `GH_TOKEN`, since
  the SSH origin has no key in the container) and merges it into the branch, so
  you can update quickly. Conflicts/errors show in the worktree's logs; resolve
  in the worktree or `git merge --abort`.
- An **⌨ Claude** button that opens **Ghostty running Claude Code** in the
  worktree's folder (inside the workspace root). Requires the host launcher (below).
- A **🗑 Delete** button that removes the worktree folder — behind an "Are you
  sure?" confirmation modal. It stops the servers, runs `git worktree remove
  --force`, frees the port block, and keeps the branch. The main repo
  (`MAIN_REPO`) can't be deleted.
- All cards are rendered at a **uniform size**.

```
workspace/
├── main-repo/       ← main repo (a worktree)
├── preview/         ← worktree
├── feature-x/       ← worktree
└── handler/         ← this app  (docker compose up -d  →  http://localhost:48000)
```

## What runs per worktree

| Server | Command | Port |
| --- | --- | --- |
| SvelteKit | `npm run dev -- --host 0.0.0.0` (with `PORT` set) | `base + 0` |

Vite reads `PORT` for the dev-server port; SvelteKit loads the worktree's own
`.env` (`DATABASE_URL`, Supabase keys, etc.), so nothing else needs injecting.

By default **nothing auto-starts** (`AUTOSTART=0`) — every server boots
**offline**. Start them with the header **Start all** (across all worktrees), a
card's **Start all**, or the server row's **Start** button.

Each worktree gets a stable **base port** the first time it's seen, persisted in
`state/ports.json`. With the defaults the dashboard is on **48000** and worktree
blocks start at **48100** (so `48100`, `48200`, `48300`, etc.). New worktrees
are detected automatically (and have their deps installed) but stay **offline**
until you start them; a removed worktree's servers are stopped.

A brand-new git worktree has **no `node_modules`** (it's gitignored, so it isn't
in the working tree), which would make `vite` fail with `vite: command not
found`. So on discovery the handler first checks for the worktree's `vite`
binary and, if missing, runs **`npm install`** in the worktree — surfaced in the
dashboard as an **"Installing dependencies…"** banner with live logs (and a
**Retry install** button if it fails). Servers only auto-start once the install
succeeds. Existing worktrees that already have deps skip straight to starting.

New worktrees don't have the gitignored `.env`, so their SvelteKit app would
fail to talk to Supabase. The handler **seeds `.env`** from the main repo
(`MAIN_REPO`) into a new worktree before starting it, so the app boots
green. Toggle with `SEED_ENV` / `MAIN_REPO`.

## Run it

```bash
cd handler
docker compose up -d --build      # or: bun run up
```

Open **http://localhost:48000**.

```bash
docker compose logs -f            # handler logs
docker compose down               # stop everything
```

It runs with `restart: unless-stopped`, so it comes back on reboot / Docker
restart and keeps reconciling worktrees.

## How it works

- **One container, host networking.** The handler and all dev servers run in a
  single container using the host network, so the dynamic per-worktree ports are
  reachable on `localhost` with no port mapping.
- **Identical-path bind mount.** `../` is mounted into the container at the same
  absolute path it has on the host, so git-worktree metadata and absolute cache
  paths (`.vite`, `node_modules` symlinks) resolve unchanged. The worktrees'
  existing host-installed `node_modules` are reused as-is (the image is Node 22
  + the same Bun version as your host).
- **Process-tree control.** Servers are spawned in their own process group, so
  Stop/Restart kills the whole `vite` child tree and frees the port.
- **Health.** A server shows `starting` until its port accepts connections, then
  `running`; an unexpected exit shows `crashed` (no auto-restart loop — click ↻).

## "Open Claude" launcher (runs on the host)

The **⌨ Claude** button opens Ghostty + Claude Code in a worktree. A Docker
container can't launch a host GUI app, so this needs a tiny launcher running in
**your desktop session** (not in Docker):

```bash
cd handler
bun run launcher        # listens on 127.0.0.1:48010
```

The dashboard button (in your browser, on this machine) calls it; the launcher
runs `ghostty --working-directory=<worktree> -e claude`. It only accepts a single
safe worktree name (no path traversal) and binds localhost only.

To keep it always running, use a systemd **user** service:

```ini
# ~/.config/systemd/user/worktree-claude-launcher.service
[Unit]
Description=worktree Claude launcher
[Service]
WorkingDirectory=%h/programing/handler
ExecStart=%h/.bun/bin/bun run %h/programing/handler/launcher.ts
Restart=on-failure
[Install]
WantedBy=default.target
```
```bash
systemctl --user enable --now worktree-claude-launcher
```

If the launcher isn't running, the button shows a hint telling you how to start it.

## Config (`.env`)

| Var | Default | Meaning |
| --- | --- | --- |
| `WORKSPACE_ROOT_HOST` | *(required)* | Folder holding the worktrees + handler (mounted at the same path) |
| `HANDLER_PORT` | `48000` | Dashboard port |
| `PORT_BASE` | `48100` | First worktree's base port |
| `PORT_STEP` | `100` | Gap between worktree blocks |
| `BUN_VERSION` | `1.3.13` | Bun pinned in the image (match your host) |
| `HOST_UID` / `HOST_GID` | `1000` | Run as your user so generated files aren't root-owned |
| `AUTOSTART` | `0` | Auto-spin a worktree's servers on discovery (`0` = everything offline; start manually) |
| `SEED_ENV` | `1` | Seed `.env` from `MAIN_REPO` into new worktrees |
| `MAIN_REPO` | `main-repo` | Source worktree for seeded env files |
| `APP_AUTH_PORT` | `0` | Shared-login funnel disabled by default |
| `AUTH_REDIRECT_URI` | empty | Override the auth funnel redirect (unused when `APP_AUTH_PORT=0`) |
| `GH_TOKEN` | — | `gh auth token` — reads real PR base/merge state, and lets "Merge main" fetch over HTTPS |
| `GIT_USER_NAME` / `GIT_USER_EMAIL` | — | Identity for the merge commit created by "Merge main" |
| `PUBLIC_HOST` | auto | Host for Open links (auto-detected LAN IP) |
| `LAUNCHER_URL` | `http://localhost:48010` | Where the host launcher listens, for the "Open Claude" button |
| `SESSION_COOKIE` | `session` | Name of the app's session cookie, for the dev-login bootstrap |

## Local run without Docker

```bash
cd handler
bun run dev        # serves on HANDLER_PORT (48000)
```