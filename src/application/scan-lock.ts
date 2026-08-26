import path from 'path';
import { DATA_DIR } from '../infrastructure/settings.js';
import { readActiveLockHolder, acquireProcessLock } from '../infrastructure/pid-lock.js';

// Cross-process guard: the web server's own auto-watcher/manual-scan/repair/clear
// routes already serialize themselves via an in-memory flag, but that can't stop a
// SEPARATE process (e.g. the MCP server, `npm run scan`, or a stray second server
// instance) from concurrently running one of these against the same __raws/__archive
// files. This file-based lock makes that cross-process case fail fast instead of racing.
// DATA_DIR, not BASE_DIR — same reasoning as the server lock in web-server.ts. The lock exists to
// serialize work over ONE __raws/__archive pair, and which pair that is comes from the data
// directory, not from which copy of the application files is running. Keyed on BASE_DIR, two
// installs sharing an app folder blocked each other, and a packaged install wrote its lock into
// resources/app — a folder upgrades replace and a real install may not let it write to.
const SCAN_LOCK_FILE = path.join(DATA_DIR, '.scan.lock');

export class ScanInProgressError extends Error {
  constructor(public readonly holderPid: number) {
    super(`A scan/repair/clear operation is already in progress (held by process ${holderPid}). Try again shortly.`);
  }
}

// In-process ownership, tracked separately from the lock FILE. readActiveLockHolder()
// deliberately reports "free" when the lock file is held by this same PID (see pid-lock.ts), so
// the file alone cannot stop a second scan starting inside the SAME process — which is exactly
// what happened when the user pressed Stop (which cleared the isAutoScanning flag without
// cancelling the running loop) and then Scan again. Two runTriageScan() loops then walked the
// same __raws listing: one moved a file to __archive between the other's directory read and its
// statSync (ENOENT), the loser of a classify race hit `UNIQUE constraint failed:
// documents.checksum` and shunted an already-archived user document into .duplicates_files, and
// whichever loop finished first deleted .scan.lock while the other was still running — which then
// let `npm run scan` or the MCP server start a third pipeline on top.
let heldInProcess = false;

export function acquireScanLock(): () => void {
  if (heldInProcess) {
    throw new ScanInProgressError(process.pid);
  }
  const holderPid = readActiveLockHolder(SCAN_LOCK_FILE);
  if (holderPid !== null) {
    throw new ScanInProgressError(holderPid);
  }
  const releaseFile = acquireProcessLock(SCAN_LOCK_FILE);
  heldInProcess = true;

  // Idempotent: a double release must not delete a lock file a LATER run now owns.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    heldInProcess = false;
    releaseFile();
  };
}
