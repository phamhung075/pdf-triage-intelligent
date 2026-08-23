# Dev server: auto-recover from a stale process on the port

Date: 2026-08-24
Owner: pipeline-engineer (`web-server.ts`); Vision Lab area is unowned, same as `vision-lab-server.ts`'s other specs.

## Problem

A `tsx watch` instance of this app, started from one directory (e.g. a git
worktree used for feature work), can keep running after the terminal moves
on. Since each directory has its own `.server.lock` file, the existing
same-directory single-instance lock (`acquireSingleInstanceLock` in
`web-server.ts`) can't see a stale instance running from a *different*
directory — they're only in conflict at the OS level, over the same TCP
port.

Today, `startWebServer`'s `EADDRINUSE` handler just logs and exits
(`web-server.ts:1302-1309`). A user hitting this has to manually find and
kill the stale process's PID before `npm run dev` will start — and in the
meantime, if they don't realize a *different* stale instance is still
serving the port, they can end up looking at that stale instance's
dashboard (wrong `BASE_DIR`, wrong data) without knowing it. This is
exactly what happened: a worktree-launched instance kept running,
squatted on port 3971, and every later `npm run dev` from `main` silently
failed while the user unknowingly kept looking at the worktree instance's
near-empty dashboard.

## Goal

On `EADDRINUSE`, automatically find whatever process is listening on the
port, kill it, and retry binding — so `npm run dev` "just takes over"
instead of requiring a manual PID hunt.

Explicitly **out of scope** (per explicit choice during design): verifying
the process holding the port is actually a previous instance of this app
before killing it. The chosen behavior always kills whatever holds the
port, accepting the (small, dev-machine-only) risk of killing an unrelated
process that happens to be on that same port.

## Design

### `killProcessOnPort` (new, `src/infrastructure/pid-lock.ts`)

Windows-only (this app targets Windows exclusively — see `CLAUDE.md`'s
`dist:exe` "portable Windows installer" target, and the existing
`windowsHide: true` pattern already used for `exec()` calls elsewhere in
this codebase, e.g. `ollama-client.ts`, `paddleocr-client.ts`).

```ts
export async function killProcessOnPort(port: number): Promise<boolean>
```

Internally: shells out to `netstat -ano -p tcp`, parses the `LISTENING`
line whose local address ends in `:${port}`, extracts the trailing PID
column, then `taskkill /PID <pid> /F`. Returns `true` if a process was
found and killed, `false` if nothing was listening on the port (so the
caller knows a retry is pointless).

### Retry-once in `startWebServer` / `startVisionLabServer`

Both `web-server.ts:1296-1310` and `vision-lab-server.ts:62-75` have the
identical shape (`app.listen(port, ...)`, an `EADDRINUSE`-checking error
handler that logs and exits). Both get the same fix: on `EADDRINUSE`, call
`killProcessOnPort(port)`, wait ~500ms for the OS to release the socket,
then retry the listen exactly **once** (a fresh `app.listen` call, not a
loop) with takeover disabled on that retry. If the retry also fails
(`killProcessOnPort` returned `false`, or the port is still taken after
killing), fall back to today's log-and-exit behavior — a single retry
prevents an infinite loop against a port that can never be freed (e.g. a
privileged system process holding it).

`acquireSingleInstanceLock()` (the existing `.server.lock` mechanism) is
unchanged — it still guards against two instances from the *same*
directory; this fix adds the missing cross-directory/OS-level layer on
top of it, not a replacement.

## Testing

No existing test file covers `startWebServer`/`startVisionLabServer`'s
`server.on('error', ...)` handlers directly (they call `process.exit`,
which isn't practical to unit test the way the rest of this codebase
tests HTTP handlers via `supertest`). `killProcessOnPort` itself is
testable in isolation: mock `child_process.exec`, assert it parses a
sample `netstat -ano` output correctly (found/not-found cases) and calls
`taskkill` with the right PID.
