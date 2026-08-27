/**
 * Windows <-> WSL path conversion — the single source of truth for every path-form problem.
 *
 * Why this module exists (history, so it never regresses):
 *
 * 1. A settings.json holding a Windows-style path (`\mnt\C:\Users\...` with backslashes) was
 *    passed to Node's fs on Linux, where backslash is a LEGAL filename character. The app never
 *    resolved it to the OneDrive folder; instead it created real directories literally named
 *    `\mnt\C:\Users\...\__raws` inside the project root and scanned those empty stubs — "the
 *    system config cannot see files on Windows".
 * 2. The reverse happened in the other direction: "Open Incoming"/"Open Archive" handed the
 *    POSIX path `/mnt/c/Users/...` straight to Windows Explorer. Explorer is a Windows program; it
 *    cannot resolve a POSIX path and silently fell back to opening C:\Users\<user>\Documents.
 *
 * The two rules that follow from this:
 *   - Paths the APP reads/writes with Node's fs on WSL must be `/mnt/<drive>/...` (POSIX).
 *   - Paths handed to WINDOWS programs (Windows Explorer, Google Chrome) must be `X:\...` (Windows).
 *
 * Pure functions, zero I/O — safe to call from domain code and unit-test anywhere.
 */

/** True when the path is a WSL mount path: `/mnt/<letter>` or `/mnt/<letter>/...`. */
export function isWslMountPath(input: string): boolean {
  return /^\/mnt\/[A-Za-z](\/.*)?$/.test(String(input ?? '').trim());
}

/**
 * Converts any Windows spelling into the POSIX `/mnt/<drive>/...` form this host's fs needs.
 *
 * On native Windows the input is already correct (Node accepts both separators) — no-op.
 * On POSIX/WSL:
 *   C:\Users\you\...      -> /mnt/c/Users/you/...
 *   \mnt\C:\Users\you\... -> /mnt/c/Users/you/...   (mangled WSL spelling from the UI)
 *   /mnt/C/Users/you/...  -> /mnt/c/Users/you/...   (uppercase drive letter)
 *   /custom/path          -> /custom/path           (plain POSIX path untouched)
 *
 * The `platform` param exists only so the unit tests can exercise the conversion on any host.
 */
export function windowsToWslPath(raw: unknown, platform: NodeJS.Platform = process.platform): string {
  const value = String(raw ?? '').trim();
  if (!value || platform === 'win32') return value;
  const forward = value.replace(/\\/g, '/');
  let m = forward.match(/^\/mnt\/([A-Za-z]):(\/.*)$/);
  if (m) return `/mnt/${m[1].toLowerCase()}${m[2]}`;
  m = forward.match(/^\/mnt\/([A-Za-z])(\/.*)$/);
  if (m) return `/mnt/${m[1].toLowerCase()}${m[2]}`;
  m = forward.match(/^([A-Za-z]):(\/.*)$/);
  if (m) return `/mnt/${m[1].toLowerCase()}${m[2]}`;
  return forward;
}

/**
 * The reverse of windowsToWslPath: converts a WSL mount path into the Windows path form that
 * Windows programs expect, so it can be handed to Windows Explorer / Google Chrome spawned from WSL.
 *
 * Pure string transform, no I/O: only `/mnt/<drive>/...` prefixes are rewritten
 * (`/mnt/c/Users/you/__raws` -> `C:\Users\you\__raws`); every other path is returned unchanged,
 * which keeps native-Windows installs (already Windows-form) and plain POSIX paths untouched.
 */
export function wslToWindowsPath(input: string): string {
  const value = String(input ?? '').trim();
  if (!value) return value;
  const m = value.match(/^\/mnt\/([A-Za-z])(\/.*)?$/);
  if (m) {
    const rest = (m[2] || '/').replace(/\//g, '\\');
    return `${m[1].toUpperCase()}:${rest}`;
  }
  return value;
}
