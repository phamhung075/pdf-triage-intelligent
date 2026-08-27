import { describe, it, expect } from 'vitest';
import { windowsToWslPath, wslToWindowsPath, isWslMountPath } from './path-conversion.js';

describe('windowsToWslPath', () => {
  it('leaves plain POSIX paths untouched', () => {
    expect(windowsToWslPath('/custom/in', 'linux')).toBe('/custom/in');
    expect(windowsToWslPath('./relative', 'linux')).toBe('./relative');
  });

  it('converts Windows drive paths to lowercase /mnt mounts on non-Windows hosts', () => {
    expect(windowsToWslPath('C:\\Users\\you\\Documents\\__raws', 'linux'))
      .toBe('/mnt/c/Users/you/Documents/__raws');
    expect(windowsToWslPath('D:/Some/Folder', 'linux')).toBe('/mnt/d/Some/Folder');
  });

  it('repairs mangled WSL spellings with backslashes and/or an uppercase drive letter', () => {
    expect(windowsToWslPath('\\mnt\\C:\\Users\\you\\__raws', 'linux'))
      .toBe('/mnt/c/Users/you/__raws');
    expect(windowsToWslPath('\\mnt\\C\\Users\\you\\__raws', 'linux'))
      .toBe('/mnt/c/Users/you/__raws');
    expect(windowsToWslPath('/mnt/C/Users/you/__raws', 'linux'))
      .toBe('/mnt/c/Users/you/__raws');
  });

  it('is a no-op on Windows hosts', () => {
    expect(windowsToWslPath('C:\\Users\\you\\__raws', 'win32')).toBe('C:\\Users\\you\\__raws');
  });
});

describe('wslToWindowsPath', () => {
  it('converts a WSL /mnt path into Windows form for explorer.exe/chrome.exe', () => {
    expect(wslToWindowsPath('/mnt/c/Users/you/Documents/__raws'))
      .toBe('C:\\Users\\you\\Documents\\__raws');
    expect(wslToWindowsPath('/mnt/d/SomeDrive/SomeFolder'))
      .toBe('D:\\SomeDrive\\SomeFolder');
    expect(wslToWindowsPath('/mnt/c')).toBe('C:\\');
  });

  it('leaves native Windows and plain POSIX paths untouched', () => {
    expect(wslToWindowsPath('C:\\Users\\you\\__raws')).toBe('C:\\Users\\you\\__raws');
    expect(wslToWindowsPath('/home/you/folder')).toBe('/home/you/folder');
    expect(wslToWindowsPath('')).toBe('');
  });
});

describe('isWslMountPath', () => {
  it('recognizes /mnt/<drive> paths', () => {
    expect(isWslMountPath('/mnt/c')).toBe(true);
    expect(isWslMountPath('/mnt/c/Users/you/__raws')).toBe(true);
    expect(isWslMountPath('/mnt/d')).toBe(true);
  });

  it('rejects non-mount paths', () => {
    expect(isWslMountPath('C:\\Users\\you')).toBe(false);
    expect(isWslMountPath('/home/you')).toBe(false);
    expect(isWslMountPath('')).toBe(false);
  });
});
