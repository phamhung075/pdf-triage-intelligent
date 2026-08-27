/**
 * Host-aware OS launching — the ONLY module allowed to know how to open a file manager or Chrome.
 *
 * Every GUI-launch in the app (web-server routes, MCP tools) must go through these builders so the
 * "Windows program gets a POSIX /mnt path and silently falls back to Documents" bug (see
 * path-conversion.ts) can never be reintroduced. The hygiene test `os-open.hygiene.test.ts` scans
 * src/ and fails the build if an `explorer.exe` / `chrome.exe` / `xdg-open` literal appears
 * anywhere outside this file.
 *
 * These builders return a spawn-ready `{ cmd, args }`; the CALLER owns the actual spawn (so the
 * web-server tests can keep mocking child_process). Fire-and-forget spawning is the caller's job:
 * `spawn(spec.cmd, spec.args, { detached: true, stdio: 'ignore' }).unref()`.
 */
import path from 'path';
import fs from 'fs';
import { isWslMountPath, wslToWindowsPath } from '../domain/path-conversion.js';

export interface LaunchSpec {
  cmd: string;
  args: string[];
}

function wslOrNative(filePath: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? filePath : wslToWindowsPath(filePath);
}

/**
 * Reveal a FILE in the OS file manager (Explorer /select, macOS Reveal / xdg-open), converting
 * WSL mount paths to Windows form before handing them to explorer.exe (WSL interop).
 */
export function revealInFileManager(filePath: string, platform: NodeJS.Platform = process.platform): LaunchSpec {
  if (platform === 'win32') return { cmd: 'explorer.exe', args: ['/select,', filePath] };
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', filePath] };
  if (isWslMountPath(filePath)) return { cmd: 'explorer.exe', args: ['/select,', wslToWindowsPath(filePath)] };
  return { cmd: 'xdg-open', args: [path.dirname(filePath)] };
}

/** Open a DIRECTORY in the OS file manager (no /select), converting WSL mounts for explorer.exe. */
export function openDirectory(dirPath: string, platform: NodeJS.Platform = process.platform): LaunchSpec {
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [dirPath] };
  if (platform === 'darwin') return { cmd: 'open', args: [dirPath] };
  if (isWslMountPath(dirPath)) return { cmd: 'explorer.exe', args: [wslToWindowsPath(dirPath)] };
  return { cmd: 'xdg-open', args: [dirPath] };
}

/**
 * Locate the Chrome executable. On native Windows the ProgramFiles env vars are set; under WSL
 * they are empty, so the /mnt/c candidates are probed too. `exists` is injectable so unit tests
 * don't touch the real fs. Returns null when nothing is found.
 */
export function resolveChromeExecutable(
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = fs.existsSync
): string | null {
  if (platform === 'darwin') {
    const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return exists(macChrome) ? macChrome : 'open';
  }
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    // WSL: the env vars above are Linux-side and empty, so look on the /mnt/c mounts.
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'chrome' || exists(c)) return c;
  }
  return null;
}

/**
 * Launch Chrome on a local PDF path. Returns null when the file doesn't exist or no Chrome
 * executable is found. The target path is converted to Windows form for chrome.exe (WSL interop);
 * the conversion is a no-op for already-Windows or plain POSIX paths.
 */
export function openInChrome(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = fs.existsSync
): LaunchSpec | null {
  if (!exists(filePath)) return null;
  const cmd = resolveChromeExecutable(platform, exists);
  if (!cmd) return null;
  return { cmd, args: [wslOrNative(filePath, platform)] };
}
