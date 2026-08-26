import fs from 'fs';
import os from 'os';
import path from 'path';

// The suite must never append to the developer's real logs/triage_debug.log. Most suites exercise
// code paths that log (triage, repair, relocalize, the image pipeline), and logger.ts writes to
// disk unconditionally — a measured 186 lines of temp-dir paths and synthetic errors per run,
// polluting the same file used to diagnose real documents. logger.ts reads PDF_TRIAGE_LOG_DIR at
// module load, and setup files run before any test module is imported, so setting it here is
// enough. A dedicated var rather than PDF_TRIAGE_DATA_DIR: several suites assert on DATA_DIR
// falling back to BASE_DIR exactly as an unconfigured git checkout does.
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-triage-test-logs-'));
process.env.PDF_TRIAGE_LOG_DIR = logDir;

// Best-effort cleanup — the OS reclaims temp dirs anyway, and a failure here must never fail a run.
process.on('exit', () => {
  try {
    fs.rmSync(logDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
