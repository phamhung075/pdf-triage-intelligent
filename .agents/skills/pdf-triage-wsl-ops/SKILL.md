---
name: pdf-triage-wsl-ops
description: Use when running or reasoning about pdf-triage's processes on WSL — path conversion between POSIX and Windows, who starts the server, the single-instance and scan locks, and the ports each service binds.
---

# Running pdf-triage on WSL

The app is developed on WSL and driven from Windows programs. Almost every operational bug in this repository's history is a path crossing that boundary or a process that should not have been started by an agent.

## Path discipline

A POSIX `/mnt/...` path must **never** be handed to a Windows program, and a `X:\...` path must never be handed to the app's own `fs` calls. Both failures are silent:

- A Windows program given `/mnt/c/...` cannot resolve it and falls back to `C:\Users\<user>\Documents` — this actually happened, and "Open Incoming / Open Archive" opened Documents instead of the target folder.
- The reverse — a Windows-form path in `settings.json` — made Node create literal `\mnt\C:\...` folders on Linux.

Rules (Golden Rule 21 in [`golden-rules.md`](../../../docs/knowledge/golden-rules.md)):

- Paths the app's own file I/O reads and writes are `/mnt/<drive>/...`; config paths are normalized at load by `WindowsToWSLPath` in the `pathconv` package (`services/pdf-triage-pdf2w/pathconv`).
- Paths handed to a Windows program are `X:\...`, produced by `WSLToWindowsPath`.
- **All OS launching lives in [`infra/osopen`](../../../services/pdf-triage-pdf2w/infra/osopen/)** — never spawn `explorer.exe`, `chrome.exe` or a Linux opener anywhere else. `infra/osopen/osopen_hygiene_test.go` fails the build if a launcher literal appears outside that package. The builders return a spawn-ready plan and the caller owns the spawn, so `httpapi` tests can keep injecting a fake launcher.
- To check whether a path needs conversion, use `IsWSLMountPath` rather than string-matching `/mnt/`.

## Who starts the server

**Not you.** Never run `make dev` or `./dist/pdf-triage serve`; ask the operator to run or restart it in their terminal (AGENTS.md non-negotiable rule 2). If you need to know whether it is up, check the port — do not start it "just to verify".

Two independent guards exist, and neither changes that rule:

- **Same-directory single-instance lock** — `httpapi`'s start path (built on `infra/pidlock`) writes this process's PID to `<DATA_DIR>/.server.lock` and refuses a second instance from the *same* base directory. It is blind to a stale instance running from a *different* directory (a worktree), even one squatting the same port.
- **Cross-directory port takeover** — on `EADDRINUSE`, the start path calls `KillProcessOnPort()` in [`infra/pidlock`](../../../services/pdf-triage-pdf2w/infra/pidlock/), waits ~500 ms, and retries binding exactly once with takeover disabled. It kills whatever holds the port with **no check that it is the same app** — a deliberate simplicity tradeoff, not an oversight. On Windows it shells out to `netstat -ano -p tcp` + `taskkill /PID <pid> /F`; on Linux/WSL it uses the POSIX process checks in `infra/pidlock`.

The scan has its own lock (`app/scanlock`, `<DATA_DIR>/.scan.lock`) so an auto-watcher tick cannot start a scan while one is running.

## Ports

| Service | Default | Bound by |
| --- | --- | --- |
| Web / API / SSE | `3971` (`PORT`) | `PDF_TRIAGE_HOST`, default `127.0.0.1` |
| Vision Lab | `3179` (`VISION_LAB_PORT`) | its own server, independent of the main app |
| MCP Streamable HTTP | `3972` (`MCP_HTTP_PORT`) | `MCP_HTTP_HOST`, default `0.0.0.0` |
| pdf2w extraction service | `3984` (`PDF2W_SERVICE_URL`) | external, self-hosted `markdown-extract-service` (separate repo, its own compose) |

MCP over stdio has no port. Full variable list: [`environment.md`](../../../docs/knowledge/environment.md).

## The dev watcher only watches Go sources

`make dev` runs the dashboard watchers (`pnpm run watch:css`, `watch:frontend`) plus `air` hot-reloading the Go backend; `.air.toml` rebuilds only on `*.go` changes under `services/pdf-triage-pdf2w` (excluding `_test.go`, `public/js`, `tmp/`, `dist/`, `node_modules/`). A running scan writing `*.db`, `registry.json`, `settings.json` or the lock files therefore cannot restart it mid-scan — no exclude list to maintain for those. The operator runs `make dev`, not the agent.

## Scanning scope

The pipeline walks `CONFIG.INPUT_DIR` (`__raws`) and nothing else — never parents, siblings, or the disk (Golden Rule 1). `__archive` is read only by Repair. A new feature that needs to look outside those two directories is a design discussion, not a patch.
