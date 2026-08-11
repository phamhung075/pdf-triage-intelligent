import path from 'path';
import { BASE_DIR } from '../infrastructure/settings.js';
import { readActiveLockHolder, acquireProcessLock } from '../infrastructure/pid-lock.js';

// Cross-process guard: the web server's own auto-watcher/manual-scan/repair/clear
// routes already serialize themselves via an in-memory flag, but that can't stop a
// SEPARATE process (e.g. the MCP server, `npm run scan`, or a stray second server
// instance) from concurrently running one of these against the same __raws/__archive
// files. This file-based lock makes that cross-process case fail fast instead of racing.
const SCAN_LOCK_FILE = path.join(BASE_DIR, '.scan.lock');

export class ScanInProgressError extends Error {
  constructor(public readonly holderPid: number) {
    super(`A scan/repair/clear operation is already in progress (held by process ${holderPid}). Try again shortly.`);
  }
}

export function acquireScanLock(): () => void {
  const holderPid = readActiveLockHolder(SCAN_LOCK_FILE);
  if (holderPid !== null) {
    throw new ScanInProgressError(holderPid);
  }
  return acquireProcessLock(SCAN_LOCK_FILE);
}
