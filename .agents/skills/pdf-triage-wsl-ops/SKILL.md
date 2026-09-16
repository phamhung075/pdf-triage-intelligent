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

- Paths the app's own `fs` reads and writes are `/mnt/<drive>/...`; config paths are normalized at load by `windowsToWslPath` in [`path-conversion.ts`](../../../src/domain/path-conversion.ts).
- Paths handed to a Windows program are `X:\...`, produced by `wslToWindowsPath`.
- **All OS launching lives in [`os-open.ts`](../../../src/infrastructure/os-open.ts)** — never spawn `explorer.exe`, `chrome.exe` or a Linux opener anywhere else. `os-open.hygiene.test.ts` fails the build if a launcher literal appears outside that file. The builders return a spawn-ready `{ cmd, args }` and the caller owns the spawn, so `web-server` tests can keep mocking `child_process`.
- To check whether a path needs conversion, use `isWslMountPath` rather than string-matching `/mnt/`.

## Who starts the server

**Not you.** Never run `npm run dev` or `npm start`; ask the user to run or restart it in their terminal (AGENTS.md non-negotiable rule 2). If you need to know whether it is up, check the port — do not start it "just to verify".

Two independent guards exist, and neither changes that rule:

- **Same-directory single-instance lock** — `acquireSingleInstanceLock()` in `web-server.ts` writes this process's PID to `<DATA_DIR>/.server.lock` and refuses a second instance from the *same* base directory. It is blind to a stale instance running from a *different* directory (a worktree), even one squatting the same port.
- **Cross-directory port takeover** — on `EADDRINUSE`, `attemptListen` calls `killProcessOnPort()` from [`pid-lock.ts`](../../../src/infrastructure/pid-lock.ts), waits ~500 ms, and retries binding exactly once with takeover disabled. It kills whatever holds the port with **no check that it is the same app** — a deliberate simplicity tradeoff, not an oversight. Note the implementation shells out to `netstat -ano -p tcp` + `taskkill /PID <pid> /F`, which is **Windows-only**; on Linux/WSL the takeover does not actually free the port.

The scan has its own lock (`scan-lock.ts`, `<DATA_DIR>/.scan.lock`) so an auto-watcher tick cannot start a scan while one is running.

## Ports

| Service | Default | Bound by |
| --- | --- | --- |
| Web / API / SSE | `3971` (`PORT`) | `PDF_TRIAGE_HOST`, default `127.0.0.1` |
| Vision Lab | `3179` (`VISION_LAB_PORT`) | its own server, independent of the main app |
| MCP Streamable HTTP | `3972` (`MCP_HTTP_PORT`) | `MCP_HTTP_HOST`, default `0.0.0.0` |
| PaddleOCR sidecar | `8871` (`PADDLEOCR_HOST`) | separate Python process |
| Extraction microservice | `3981` (`PDF_EXTRACT_PORT`) | Docker / `npm run extract:dev` |
| Docling service | `3984` | separate repo: `markdown-extract-service` |

MCP over stdio has no port. Full variable list: [`environment.md`](../../../docs/knowledge/environment.md).

## The dev watcher ignores runtime files on purpose

`npm run dev` runs `tsx watch --exclude ...` over `*.db`, `*.db-{journal,shm,wal}`, `registry.json`, `categories.json`, `settings.json`, `logs/**`, `.server.lock`, `.scan.lock`. A running scan writes those constantly; without the excludes every write would restart the server mid-scan. If you add a runtime file the app rewrites in place, add it to that list — and do not remove entries to "simplify" the command.

## Scanning scope

The pipeline walks `CONFIG.INPUT_DIR` (`__raws`) and nothing else — never parents, siblings, or the disk (Golden Rule 1). `__archive` is read only by Repair. A new feature that needs to look outside those two directories is a design discussion, not a patch.
