import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // crop-quad.ts is canvas geometry, so it lives with the frontend it serves — but it is pure
    // and fully unit-tested, so its tests run in the same suite as the backend's.
    include: ['src/**/*.test.ts', 'public/ts/**/*.test.ts'],
    // Redirects logger.ts's file writes into a temp dir so `npm test` stops appending synthetic
    // pipeline errors to the real logs/triage_debug.log. See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
    // vitest's 5s default is below this codebase's cold module-load cost, which makes `npm test`
    // nondeterministically red: roughly one run in three failed on whichever test happened to be
    // the first `await import()` in its file — triage-scan-duplicate-collision.test.ts:102,
    // paddleocr-client.test.ts:353, mcp-server.test.ts:93. Those three pass every time in
    // isolation, and one of them only calls a pure function (`ocrTimeoutFor`), so the time is spent
    // pulling in the import graph — pdfjs-dist, @napi-rs/canvas, tesseract.js, sqlite3 — while
    // every worker does the same thing at once (cumulative `import` is ~50s for a ~10s run).
    // 20s keeps a genuinely hung test failing while leaving room for a cold import under load.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
