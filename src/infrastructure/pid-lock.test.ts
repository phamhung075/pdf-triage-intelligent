import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { isProcessRunning, readActiveLockHolder, acquireProcessLock } from './pid-lock.js';

let tempDir: string;
let lockFile: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-lock-test-'));
  lockFile = path.join(tempDir, '.scan.lock');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function spawnChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  return new Promise((resolve) => {
    if (child.pid) resolve(child);
    else child.once('spawn', () => resolve(child));
  });
}

describe('isProcessRunning', () => {
  it('returns true for the current process', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it('returns false for a process that has already exited', async () => {
    const child = await spawnChild();
    const pid = child.pid!;
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(isProcessRunning(pid)).toBe(false);
  }, 10_000);
});

describe('readActiveLockHolder', () => {
  it('returns null when the lock file does not exist', () => {
    expect(readActiveLockHolder(lockFile)).toBeNull();
  });

  it('returns null when the lock file contains garbage (non-numeric) content', () => {
    fs.writeFileSync(lockFile, 'not-a-pid');
    expect(readActiveLockHolder(lockFile)).toBeNull();
  });

  it('returns null when the lock file holds this process\'s own PID', () => {
    fs.writeFileSync(lockFile, String(process.pid));
    expect(readActiveLockHolder(lockFile)).toBeNull();
  });

  it('returns null when the lock file holds a PID of a process that has already exited (stale lock)', async () => {
    const child = await spawnChild();
    const pid = child.pid!;
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    fs.writeFileSync(lockFile, String(pid));
    expect(readActiveLockHolder(lockFile)).toBeNull();
  }, 10_000);

  it('returns the holder PID when the lock file holds a genuinely running other process', async () => {
    const child = await spawnChild();
    try {
      fs.writeFileSync(lockFile, String(child.pid));
      expect(readActiveLockHolder(lockFile)).toBe(child.pid);
    } finally {
      child.kill();
    }
  }, 10_000);
});

describe('acquireProcessLock', () => {
  it('writes this process\'s PID to the lock file', () => {
    acquireProcessLock(lockFile);
    expect(fs.readFileSync(lockFile, 'utf-8').trim()).toBe(String(process.pid));
  });

  it('release() removes the lock file', () => {
    const release = acquireProcessLock(lockFile);
    release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('release() does not remove the lock file if its content no longer matches this process', () => {
    const release = acquireProcessLock(lockFile);
    fs.writeFileSync(lockFile, '999999'); // simulate another process having taken over
    release();
    expect(fs.existsSync(lockFile)).toBe(true);
  });
});
