import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { isProcessRunning, readActiveLockHolder, acquireProcessLock, killProcessOnPort } from './pid-lock.js';

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, exec: execMock };
});

let tempDir: string;
let lockFile: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-lock-test-'));
  lockFile = path.join(tempDir, '.scan.lock');
  execMock.mockReset();
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

describe('killProcessOnPort', () => {
  it('finds and kills the process listening on the given port', async () => {
    execMock.mockImplementation((cmd: string, _opts: any, cb: (err: any, stdout: string) => void) => {
      if (cmd.startsWith('netstat')) {
        cb(null, [
          'Active Connections',
          '',
          '  Proto  Local Address          Foreign Address        State           PID',
          '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044',
          '  TCP    0.0.0.0:3971           0.0.0.0:0              LISTENING       2152',
        ].join('\n'));
      } else if (cmd.startsWith('taskkill')) {
        cb(null, '');
      }
    });

    const result = await killProcessOnPort(3971);

    expect(result).toBe(true);
    expect(execMock).toHaveBeenCalledWith('taskkill /PID 2152 /F', expect.objectContaining({ windowsHide: true }), expect.any(Function));
  });

  it('returns false when nothing is listening on the port', async () => {
    execMock.mockImplementation((cmd: string, _opts: any, cb: (err: any, stdout: string) => void) => {
      if (cmd.startsWith('netstat')) {
        cb(null, [
          'Active Connections',
          '',
          '  Proto  Local Address          Foreign Address        State           PID',
          '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044',
        ].join('\n'));
      }
    });

    const result = await killProcessOnPort(3971);

    expect(result).toBe(false);
    expect(execMock).toHaveBeenCalledTimes(1); // only netstat ran — no taskkill attempted
  });
});
