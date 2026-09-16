---
name: pdf-triage-verify
description: Use before claiming any change to pdf-triage works, or before committing — selects and runs the repository's three real gates (`typecheck`, `test`, `build:frontend`) and names the traps that make a green run misleading.
---

# Verifying a change in pdf-triage

There is no `make check`. Three commands cover the repository, and **which ones you need depends on what you touched** — running `npm test` alone is not verification.

| You changed | Required commands |
| --- | --- |
| `src/**`, `prompts/**`, `categories.json`, `entity_dictionary.json` | `npm run typecheck` && `npm test` |
| `public/ts/**` (frontend source) | the above **plus** `npm run build:frontend` |
| `public/scss/**` | `npm run build:css` (or `build:frontend`, which runs it first) |
| `package.json`, `tsconfig*.json`, `vitest.config.ts` | `npm run typecheck` && `npm test` && `npm run build` |
| `docs/**`, `AGENTS.md`, `CHANGELOG.md` | nothing — but see [pdf-triage-change](../pdf-triage-change/SKILL.md) |

## The three gates

- **`npm run typecheck`** — `tsc -p tsconfig.test.json && tsc -p tsconfig.frontend.json`, no emit. Two projects, because the backend and the browser frontend have different `lib`/`types` settings; a green backend does not imply a green frontend.
- **`npm test`** — `vitest run`. The suite is deliberately wider than `src/`: `vitest.config.ts` includes `public/ts/**/*.test.ts`, so `crop-quad.ts` geometry tests run alongside the backend's.
- **`npm run build:frontend`** — `build:css` then `tsc -p tsconfig.frontend.json`.

## Traps

**`public/js/` is generated, not source.** The browser is served `public/js/*.js`; the sources are `public/ts/*.ts`. **Nothing recompiles them automatically** — nothing watches, and the main server's `tsx watch` only reloads the backend. Editing `public/js/*.js` directly appears to work until the next `build:frontend` silently overwrites it. Edit `public/ts/` and run `build:frontend` before telling anyone the UI change is done.

**The test timeout is 20 s on purpose.** `vitest.config.ts` raises `testTimeout`/`hookTimeout` from vitest's 5 s default because this codebase's cold module-load graph (`pdfjs-dist`, `@napi-rs/canvas`, `tesseract.js`, `sqlite3`) exceeds it when every worker imports at once — the historical failure was roughly one run in three, on whichever test happened to be first to `await import()` in its file. Do not lower it to make a slow test "pass"; treat a timeout as a real hang.

**`npm run build` puts `clean:dist` first for a reason.** `tsc` never prunes output for deleted sources, and `package.json` ships `dist/**/*` into the `.exe` — so without `clean:dist` an orphaned `.js` from a removed module is packaged forever. If you are debugging a stale symbol in a built artifact, suspect this before the source.

**`vitest.setup.ts` redirects log writes.** It keeps `npm test` from appending synthetic pipeline errors to the real `logs/triage_debug.log`. Do not weaken it to make an assertion easier.

## Never

**Do not run the server.** `npm run dev` and `npm start` are the user's commands — ask them to run or restart it in their terminal (AGENTS.md non-negotiable rule 2, Golden Rule 2). This holds even when you believe a restart is required to test your change.

## Evidence

Report the exact command and its result — `npm test` → `Tests  N passed`. A passing typecheck is not a passing test suite, and neither one proves the UI recompiled. If a check could not run, say so and say why; an unrun gate is a gap, not a detail.
