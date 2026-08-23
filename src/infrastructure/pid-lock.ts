import fs from 'fs';
import { exec } from 'child_process';

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}

// Returns the existing lock holder's PID if the lock is currently held by a still-running
// OTHER process, or null if the lock is free, stale (holder no longer running), or held
// by this same process.
export function readActiveLockHolder(lockFilePath: string): number | null {
  if (!fs.existsSync(lockFilePath)) return null;
  const existingPid = parseInt(fs.readFileSync(lockFilePath, 'utf-8').trim(), 10);
  if (!isNaN(existingPid) && existingPid !== process.pid && isProcessRunning(existingPid)) {
    return existingPid;
  }
  return null;
}

// Writes this process's PID to lockFilePath and returns a release function that removes
// the lock file — but only if it still belongs to this process (avoids deleting a lock
// another process has since acquired).
export function acquireProcessLock(lockFilePath: string): () => void {
  fs.writeFileSync(lockFilePath, String(process.pid), 'utf-8');
  return () => {
    try {
      if (fs.existsSync(lockFilePath) && fs.readFileSync(lockFilePath, 'utf-8').trim() === String(process.pid)) {
        fs.unlinkSync(lockFilePath);
      }
    } catch (e) {}
  };
}

// Finds the PID of whatever process is LISTENING on `port` by parsing `netstat -ano` output —
// Windows only (this app targets Windows exclusively, see CLAUDE.md's dist:exe target).
function findPidOnPort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    exec('netstat -ano -p tcp', { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      const line = stdout.split('\n').find((l) => {
        const cols = l.trim().split(/\s+/);
        return cols[1] && cols[1].endsWith(`:${port}`) && cols[3] === 'LISTENING';
      });
      if (!line) { resolve(null); return; }
      const cols = line.trim().split(/\s+/);
      const pid = parseInt(cols[cols.length - 1], 10);
      resolve(isNaN(pid) ? null : pid);
    });
  });
}

// Finds and force-kills whatever process is listening on `port`, so a caller that just hit
// EADDRINUSE can retry binding instead of requiring a manual PID hunt (a stale tsx-watch
// instance from a different directory — e.g. a git worktree — squatting on the same port is
// invisible to the same-directory .server.lock check above, since it's only a conflict at the
// OS/port level). Always kills whatever holds the port, with no check that it's a previous
// instance of this same app — by design, see the port-takeover design doc. Returns true if a
// process was found and killed, false if nothing was listening on the port (so the caller
// knows a retry is pointless).
export async function killProcessOnPort(port: number): Promise<boolean> {
  const pid = await findPidOnPort(port);
  if (pid === null) return false;
  await new Promise<void>((resolve) => {
    exec(`taskkill /PID ${pid} /F`, { windowsHide: true }, () => resolve());
  });
  return true;
}
