import { describe, it, expect } from 'vitest';
import path from 'path';
import { revealInFileManager, openDirectory, resolveChromeExecutable, openInChrome } from './os-open.js';

describe('revealInFileManager', () => {
  it('uses Explorer /select on native Windows (path already Windows-form)', () => {
    const spec = revealInFileManager('C:\\Users\\you\\__archive\\a.pdf', 'win32');
    expect(spec).toEqual({ cmd: 'explorer.exe', args: ['/select,', 'C:\\Users\\you\\__archive\\a.pdf'] });
  });

  it('uses Finder reveal on macOS', () => {
    const spec = revealInFileManager('/Users/you/a.pdf', 'darwin');
    expect(spec).toEqual({ cmd: 'open', args: ['-R', '/Users/you/a.pdf'] });
  });

  it('converts a WSL mount path to Windows form before handing it to explorer.exe (interop)', () => {
    const spec = revealInFileManager('/mnt/c/Users/you/__archive/a.pdf', 'linux');
    expect(spec).toEqual({ cmd: 'explorer.exe', args: ['/select,', 'C:\\Users\\you\\__archive\\a.pdf'] });
  });

  it('falls back to xdg-open with the parent dir for plain Linux paths', () => {
    const spec = revealInFileManager('/home/you/archive/a.pdf', 'linux');
    expect(spec).toEqual({ cmd: 'xdg-open', args: ['/home/you/archive'] });
  });
});

describe('openDirectory', () => {
  it('opens the dir directly in Explorer on Windows', () => {
    expect(openDirectory('C:\\Users\\you\\__raws', 'win32'))
      .toEqual({ cmd: 'explorer.exe', args: ['C:\\Users\\you\\__raws'] });
  });

  it('converts a WSL mount dir for explorer.exe on Linux', () => {
    expect(openDirectory('/mnt/c/Users/you/__raws', 'linux'))
      .toEqual({ cmd: 'explorer.exe', args: ['C:\\Users\\you\\__raws'] });
  });

  it('uses xdg-open for a plain Linux dir', () => {
    expect(openDirectory('/home/you/raws', 'linux'))
      .toEqual({ cmd: 'xdg-open', args: ['/home/you/raws'] });
  });
});

describe('resolveChromeExecutable', () => {
  const exists = (paths: string[]) => (p: string) => paths.includes(p);

  it('picks the first existing candidate (Program Files on Windows)', () => {
    // path.join uses the HOST separator, so on a Linux test host the candidate is forward-slash
    // mixed form; on a real Windows host it is pure backslashes. Build the expected the same way.
    const expected = path.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
    expect(resolveChromeExecutable('win32', exists([expected]))).toBe(expected);
  });

  it('probes the /mnt/c mounts under WSL when the Program Files env vars are empty', () => {
    // Simulate a Linux host: no ProgramFiles env; only the /mnt/c candidate exists.
    expect(resolveChromeExecutable('linux', exists(['/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'])))
      .toBe('/mnt/c/Program Files/Google/Chrome/Application/chrome.exe');
  });

  it('falls back to the bare "chrome" command when nothing is found on disk', () => {
    expect(resolveChromeExecutable('linux', () => false)).toBe('chrome');
  });
});

describe('openInChrome', () => {
  const existsAll = () => true;

  it('returns null when the target file does not exist', () => {
    expect(openInChrome('/mnt/c/x.pdf', 'linux', () => false)).toBeNull();
  });

  it('converts a WSL target path for chrome.exe', () => {
    const target = '/mnt/c/Users/you/__archive/a.pdf';
    const onlyWslChrome = (p: string) => p === target || p === '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';
    const spec = openInChrome(target, 'linux', onlyWslChrome);
    expect(spec?.cmd).toBe('/mnt/c/Program Files/Google/Chrome/Application/chrome.exe');
    expect(spec?.args).toEqual(['C:\\Users\\you\\__archive\\a.pdf']);
  });

  it('keeps an already-Windows path as-is', () => {
    const spec = openInChrome('C:\\Users\\you\\a.pdf', 'win32', existsAll);
    expect(spec?.args).toEqual(['C:\\Users\\you\\a.pdf']);
  });
});
