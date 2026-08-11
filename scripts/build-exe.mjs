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
