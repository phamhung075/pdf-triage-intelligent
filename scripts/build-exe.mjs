// Builds the Windows portable distributable, then guarantees the process actually exits.
//
// `electron-builder --win` run as a plain CLI command sometimes never returns control to the
// terminal after the build output is fully written to disk (observed: dist-installer/win-unpacked
// completely populated, timestamps all matching, but the CLI process itself stays alive — most
// likely Windows Defender/AV holding a lock while it scans the freshly-written electron.exe and
// native .dll bindings, sqlite3/canvas/tesseract). Requiring a manual Ctrl+C every time isn't
// "automatic". This script spawns electron-builder as a child, exits the moment its `close` event
// fires, and force-kills the whole process tree if that hasn't happened within BUILD_TIMEOUT_MS as
// a safety net against a genuinely stuck build.
import fs from 'fs';
import { execSync, spawn } from 'child_process';

const BUILD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — generous for a cold build with native deps

function killIfRunning(imageName) {
  try {
    execSync(`taskkill /F /IM "${imageName}" /T`, { stdio: 'ignore' });
  } catch {
    // Not running — expected most of the time, not an error.
  }
}

killIfRunning('Smart PDF Triage.exe');
killIfRunning('electron.exe');

// A running dev server (`npm run dev`) holds node_sqlite3.node open, and @electron/rebuild has to
// unlink it — so the build dies several minutes in with a bare
// "EPERM: operation not permitted, unlink ...node_sqlite3.node" that says nothing about the cause.
// Detect the lock directly (rename the file and put it back: that is exactly the operation rebuild
// needs and cannot be faked by a permissions check) and say what to do about it.
//
// The dev server is deliberately NOT killed here: it is the user's own foreground process, started
// in their terminal, and taking it out from under a build script would be surprising.
// @electron/rebuild has to unlink node_sqlite3.node to rebuild it against Electron's ABI. Any
// process that has the module LOADED blocks that, and the build dies minutes later with a bare
//   EPERM: operation not permitted, unlink ...node_sqlite3.node
// that names no culprit. Detect it up front.
//
// The probe is an exclusive open, chosen by testing every candidate against a real lock: rename
// round-trips, copyFile, and unlinking a hardlink ALL SUCCEED on a loaded .node (Windows maps it
// with FILE_SHARE_DELETE), so they look fine right up until rebuild's unlink fails. Only opening
// for write reports the lock, as EBUSY. Do not 'simplify' this to a rename check.
//
// No process is killed here. The holder is often the user's own foreground work -- the dev
// server, the desktop app, or a long-running script that opened the database -- and taking that
// out from under them without asking would be surprising.
const NATIVE_BINDING = 'node_modules/sqlite3/build/Release/node_sqlite3.node';
if (fs.existsSync(NATIVE_BINDING)) {
  let lockedBy = null;
  try {
    fs.closeSync(fs.openSync(NATIVE_BINDING, 'r+'));
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') lockedBy = err.code;
    // Anything else (missing file, read-only checkout) is not this problem -- let the real build
    // surface it rather than guessing.
  }

  if (lockedBy) {
    console.error(`
Cannot build: sqlite3's native binding is loaded by a running process (${lockedBy}).

  ${NATIVE_BINDING}

electron-builder has to replace this file, and Windows will not let it while some process has
it mapped. Usual suspects, in order:
  - the dev server            (npm run dev)
  - the desktop app           (npm run desktop, or a built Smart PDF Triage.exe)
  - a long-running script     (anything under scratch/ that opened the database)
  - a stray test/tsx process  left over from an earlier run

Find the holder, then stop it and re-run: npm run dist:exe

  powershell -NoProfile -Command \"Get-Process node,electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Modules.FileName -like '*node_sqlite3.node' } |
    Select-Object Id, ProcessName, Path\"
`);
    process.exit(1);
  }
}

try {
  fs.rmSync('dist-installer', { recursive: true, force: true });
} catch {}

console.log('Building Windows distributable...');

const child = spawn('npx', ['electron-builder', '--win'], {
  stdio: 'inherit',
  shell: true,
});

const watchdog = setTimeout(() => {
  console.warn(`\nelectron-builder did not exit within ${BUILD_TIMEOUT_MS / 60000} minutes of finishing its own output — forcing it to stop. Check dist-installer/win-unpacked for the build result; it's usually already complete by this point.`);
  if (child.pid) {
    try {
      execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
    } catch {}
  }
  process.exit(0);
}, BUILD_TIMEOUT_MS);

child.on('close', (code) => {
  clearTimeout(watchdog);
  console.log(code === 0 ? '\nBuild finished.' : `\nelectron-builder exited with code ${code}.`);
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  clearTimeout(watchdog);
  console.error('Failed to launch electron-builder:', err.message);
  process.exit(1);
});
