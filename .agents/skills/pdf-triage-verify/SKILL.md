---
name: pdf-triage-verify
description: Use before claiming any change to pdf-triage works, or before committing — selects and runs the repository's three real gates (`make test`, `pnpm run typecheck`, `pnpm run build:frontend`) and names the traps that make a green run misleading.
---

# Verifying a change in pdf-triage

There is no `make check`. Three commands cover the repository, and **which ones you need depends on what you touched** — running `make test` alone is not verification.

| You changed | Required commands |
| --- | --- |
| `services/pdf-triage-pdf2w/**` (the Go backend) | `make test` |
| `prompts/**`, `categories.json`, `entity_dictionary.json` | `make test` |
| `public/ts/**` (frontend source) | `pnpm run typecheck` && `pnpm run build:frontend` |
| `public/scss/**` | `pnpm run build:css` (or `build:frontend`, which runs it first) |
| `package.json`, `tsconfig*.json` | `pnpm run typecheck` && `pnpm run build:frontend` |
| `docs/**`, `AGENTS.md`, `CHANGELOG.md` | nothing — but see [pdf-triage-change](../pdf-triage-change/SKILL.md) |

## The three gates

- **`make test`** — `cd services/pdf-triage-pdf2w && go test ./...`. The whole Go module; the backend is one binary, so there is no separate Go typecheck.
- **`pnpm run typecheck`** — `tsc -p tsconfig.frontend.json --noEmit`, the browser dashboard only.
- **`pnpm run build:frontend`** — `build:css` then `tsc -p tsconfig.frontend.json`.

## Traps

**`public/js/` is generated, not source.** The browser is served `public/js/*.js`; the sources are `public/ts/*.ts`. **Nothing recompiles them automatically** — only the `pnpm run watch:frontend` / `watch:css` scripts do, and only while they are running. Editing `public/js/*.js` directly appears to work until the next `build:frontend` silently overwrites it. Edit `public/ts/` and run `build:frontend` before telling anyone the UI change is done.

**The Go backend and the dashboard are separate toolchains.** `make test` compiles and tests the Go submodule; `pnpm run typecheck` / `build:frontend` compile only `public/ts`. A green Go run says nothing about the dashboard, and a green typecheck says nothing about Go.

**`make build` is not a test.** It compiles the dashboard then the Go binary into `dist/pdf-triage`; it runs no tests. Use it to check the build links, not to check behavior.

**`make test` uses no docker, server, or Ollama.** The Go suite is hermetic — it must not need `make dev` or a running binary. If a test appears to require one, that is the bug.

## Never

**Do not run the server.** `make dev` and `./dist/pdf-triage serve` are the operator's commands — ask them to run or restart it in their terminal (AGENTS.md non-negotiable rule 2, Golden Rule 2). This holds even when you believe a restart is required to test your change.

## Evidence

Report the exact command and its result — `make test` → `ok  github.com/phamhung075/pdf-triage-pdf2w/...`. A passing typecheck is not a passing test suite, and neither one proves the UI recompiled. If a check could not run, say so and say why; an unrun gate is a gap, not a detail.
