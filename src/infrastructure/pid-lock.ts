import fs from 'fs';

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
