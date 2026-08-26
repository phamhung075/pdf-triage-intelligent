import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, ChildProcess } from 'child_process';

// scan-lock.ts derives its lock file path from BASE_DIR, which settings.ts hardcodes as a
// literal absolute path to the real project directory (NOT process.env-configurable like
// INPUT_DIR/DB_PATH are). Left un-mocked, these tests would create/manipulate a REAL
// .scan.lock file in the actual project — mock the whole settings module with a temp
// BASE_DIR instead, and let pid-lock.ts's real fs calls run against that safe location.
let tempBaseDir: string;

vi.mock('../infrastructure/settings.js', () => ({
  // DATA_DIR falls back to BASE_DIR when PDF_TRIAGE_DATA_DIR is unset, which is what a git
  // checkout does — so the lock files land in the same temp dir the rest of the test uses.
  get DATA_DIR() { return tempBaseDir; },
  get BASE_DIR() { return tempBaseDir; },
}));

beforeEach(() => {
  tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-triage-scanlock-'));
});

afterEach(() => {
  fs.rmSync(tempBaseDir, { recursive: true, force: true });
});

async function freshScanLock() {
  vi.resetModules();
  return import('./scan-lock.js');
}

function lockFilePath() {
  return path.join(tempBaseDir, '.scan.lock');
}

describe('acquireScanLock', () => {
  it('acquires the lock and writes this process\'s PID to the lock file', async () => {
    const { acquireScanLock } = await freshScanLock();
    const release = acquireScanLock();
    expect(fs.existsSync(lockFilePath())).toBe(true);
    expect(fs.readFileSync(lockFilePath(), 'utf-8').trim()).toBe(String(process.pid));
    release();
  });

  it('release() removes the lock file', async () => {
    const { acquireScanLock } = await freshScanLock();
    const release = acquireScanLock();
    release();
    expect(fs.existsSync(lockFilePath())).toBe(false);
  });

  it('release() does not remove the lock file if it no longer belongs to this process', async () => {
    const { acquireScanLock } = await freshScanLock();
    const release = acquireScanLock();
    // Simulate another process having since taken over the lock file.
    fs.writeFileSync(lockFilePath(), '999999');
    release();
    expect(fs.existsSync(lockFilePath())).toBe(true);
  });

  it('treats a lock file written with this process\'s own PID as free, not blocking', async () => {
    fs.mkdirSync(tempBaseDir, { recursive: true });
    fs.writeFileSync(lockFilePath(), String(process.pid));
    const { acquireScanLock } = await freshScanLock();
    expect(() => acquireScanLock()).not.toThrow();
  });

  it('throws ScanInProgressError with the holder PID when the lock is held by another actually-running process', async () => {
    const child: ChildProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    try {
      await new Promise<void>((resolve) => {
        if (child.pid) resolve();
        else child.once('spawn', () => resolve());
      });
      fs.writeFileSync(lockFilePath(), String(child.pid));

      const { acquireScanLock, ScanInProgressError } = await freshScanLock();
      expect(() => acquireScanLock()).toThrow(ScanInProgressError);
      try {
        acquireScanLock();
      } catch (err: any) {
        expect(err.holderPid).toBe(child.pid);
        expect(err.message).toContain(String(child.pid));
      }
    } finally {
      child.kill();
    }
  }, 10_000);
});

describe('acquireScanLock — same-process re-entry', () => {
  it('rejects a SECOND acquisition while the first is still held', async () => {
    // The regression this guards: readActiveLockHolder deliberately reports "free" when the lock
    // file holds this same PID (see the test above, which pins that intent), so the FILE alone
    // could never stop a second scan starting inside one process. That is exactly what happened
    // when the user pressed Stop — which cleared the in-memory isAutoScanning guard without
    // cancelling the running loop — and then pressed Scan again. Two runTriageScan loops then
    // walked the same __raws listing: one moved a file to __archive between the other's directory
    // read and its statSync (ENOENT), and the loser of a classify race hit
    // `UNIQUE constraint failed: documents.checksum` and shunted an already-archived user document
    // into .duplicates_files.
    const { acquireScanLock, ScanInProgressError } = await freshScanLock();

    const release = acquireScanLock();
    expect(() => acquireScanLock()).toThrow(ScanInProgressError);

    release();
  });

  it('allows a new acquisition once the first is released', async () => {
    const { acquireScanLock } = await freshScanLock();
    acquireScanLock()();
    expect(() => acquireScanLock()()).not.toThrow();
  });

  it('makes release idempotent, so a stale handle cannot delete a lock a later run owns', async () => {
    // Both concurrent runs used to hold a release fn that deleted the file on PID match, so
    // whichever finished first unlocked .scan.lock while the other was still running — which then
    // let `npm run scan` or the MCP server start a third pipeline on top of it.
    const { acquireScanLock } = await freshScanLock();

    const staleRelease = acquireScanLock();
    staleRelease();
    staleRelease(); // no-op

    const laterRun = acquireScanLock();
    expect(fs.existsSync(lockFilePath())).toBe(true);

    staleRelease();
    expect(fs.existsSync(lockFilePath())).toBe(true);

    laterRun();
    expect(fs.existsSync(lockFilePath())).toBe(false);
  });

  it('frees in-process ownership even when the scan body throws', async () => {
    const { acquireScanLock } = await freshScanLock();

    const release = acquireScanLock();
    try {
      throw new Error('scan blew up');
    } catch {
      release();
    }

    expect(() => acquireScanLock()()).not.toThrow();
  });
});
