import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

vi.mock('fs');

describe('config.ts', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
  });

  describe('loadCustomSettings', () => {
    it('returns {} when settings.json does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { loadCustomSettings } = await import('./settings.js');
      expect(loadCustomSettings()).toEqual({});
    });

    it('returns the parsed object when settings.json is valid JSON', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ input_dir: 'X' }) as any);
      const { loadCustomSettings } = await import('./settings.js');
      expect(loadCustomSettings()).toEqual({ input_dir: 'X' });
    });

    it('returns {} (not a throw) when settings.json is malformed', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('{not valid json' as any);
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { loadCustomSettings } = await import('./settings.js');
      expect(loadCustomSettings()).toEqual({});
      consoleErrorSpy.mockRestore();
    });
  });

  describe('CONFIG derivation at module load', () => {
    it('picks up input_dir/output_root_dir/ollama_host/personal_name_denylist from settings.json', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          input_dir: '/custom/in',
          output_root_dir: '/custom/out',
          ollama_host: 'http://custom-host:1234',
          personal_name_denylist: ['Alice', ' Bob '],
        }) as any
      );
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.INPUT_DIR).toBe('/custom/in');
      expect(CONFIG.OUTPUT_ROOT_DIR).toBe('/custom/out');
      expect(CONFIG.OLLAMA_HOST).toBe('http://custom-host:1234');
      expect(CONFIG.PERSONAL_NAME_DENYLIST).toEqual(['alice', 'bob']);
    });

    it('rejects an unsupported ollama_model and falls back to qwen3.5:9b (Golden Rule #14)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ ollama_model: 'kimi-k3:cloud' }) as any
      );
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.OLLAMA_MODEL).toBe('qwen3.5:9b');
      consoleWarnSpy.mockRestore();
    });

    it('defaults OLLAMA_VISION_MODEL to minicpm-v4.6:latest with no env override', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.OLLAMA_VISION_MODEL).toBe('minicpm-v4.6:latest');
    });

    it('rejects an unsupported OLLAMA_VISION_MODEL env override and falls back', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const original = process.env.OLLAMA_VISION_MODEL;
      process.env.OLLAMA_VISION_MODEL = 'llava:7b';
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.OLLAMA_VISION_MODEL).toBe('minicpm-v4.6:latest');
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('llava:7b'));
      consoleWarnSpy.mockRestore();
      if (original === undefined) delete process.env.OLLAMA_VISION_MODEL;
      else process.env.OLLAMA_VISION_MODEL = original;
    });

    it('defaults VISION_LAB_PORT to 3179 with no env override', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const original = process.env.VISION_LAB_PORT;
      delete process.env.VISION_LAB_PORT;
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.VISION_LAB_PORT).toBe(3179);
      if (original !== undefined) process.env.VISION_LAB_PORT = original;
    });

    it('reads VISION_LAB_PORT from an env override', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const original = process.env.VISION_LAB_PORT;
      process.env.VISION_LAB_PORT = '4000';
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.VISION_LAB_PORT).toBe(4000);
      if (original === undefined) delete process.env.VISION_LAB_PORT;
      else process.env.VISION_LAB_PORT = original;
    });

    it('defaults PADDLEOCR_HOST to http://127.0.0.1:8871 with no env override', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const original = process.env.PADDLEOCR_HOST;
      delete process.env.PADDLEOCR_HOST;
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.PADDLEOCR_HOST).toBe('http://127.0.0.1:8871');
      if (original !== undefined) process.env.PADDLEOCR_HOST = original;
    });

    it('reads PADDLEOCR_HOST from an env override', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const original = process.env.PADDLEOCR_HOST;
      process.env.PADDLEOCR_HOST = 'http://127.0.0.1:9999';
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.PADDLEOCR_HOST).toBe('http://127.0.0.1:9999');
      if (original === undefined) delete process.env.PADDLEOCR_HOST;
      else process.env.PADDLEOCR_HOST = original;
    });

    it('defaults PADDLEOCR_SPAWN_CMD to "python paddleocr-server/main.py" with no env override', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const original = process.env.PADDLEOCR_SPAWN_CMD;
      delete process.env.PADDLEOCR_SPAWN_CMD;
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.PADDLEOCR_SPAWN_CMD).toBe('python paddleocr-server/main.py');
      if (original !== undefined) process.env.PADDLEOCR_SPAWN_CMD = original;
    });

    it('defaults PERSONAL_NAME_DENYLIST to an empty array when settings.json has none', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { CONFIG } = await import('./settings.js');
      expect(CONFIG.PERSONAL_NAME_DENYLIST).toEqual([]);
    });
  });

  describe('updateConfig', () => {
    it('mutates CONFIG in place and persists sanitized settings to disk', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { CONFIG, updateConfig } = await import('./settings.js');
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      updateConfig({ input_dir: '/new/in', ollama_model: 'not-allowed-model' });
      expect(CONFIG.INPUT_DIR).toBe('/new/in');
      expect(CONFIG.OLLAMA_MODEL).toBe('qwen3.5:9b');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('settings.json'),
        expect.stringContaining('"qwen3.5:9b"'),
        'utf-8'
      );
      consoleWarnSpy.mockRestore();
    });
  });

  describe('reloadConfigFromDisk', () => {
    it('re-reads settings.json and mutates the existing CONFIG object', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ input_dir: '/first' }) as any);
      const { CONFIG, reloadConfigFromDisk } = await import('./settings.js');
      expect(CONFIG.INPUT_DIR).toBe('/first');

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ input_dir: '/second' }) as any);
      reloadConfigFromDisk();
      expect(CONFIG.INPUT_DIR).toBe('/second');
    });

    it.skipIf(process.platform === 'win32')('normalizes a mangled Windows path from settings.json into a real WSL /mnt path', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          input_dir: '\\mnt\\C:\\Users\\you\\Documents\\__raws',
          output_root_dir: 'C:\\Users\\you\\Documents\\__archive',
        }) as any
      );
      const { CONFIG, reloadConfigFromDisk } = await import('./settings.js');
      expect(CONFIG.INPUT_DIR).toBe('/mnt/c/Users/you/Documents/__raws');
      expect(CONFIG.OUTPUT_ROOT_DIR).toBe('/mnt/c/Users/you/Documents/__archive');
    });
  });

  describe('path-conversion re-exports', () => {
    // The conversion logic itself lives and is fully tested in src/domain/path-conversion.ts;
    // settings.js only re-exports it under the historical names so existing importers keep
    // working. These two assertions pin that the re-export stays wired.
    it('re-exports windowsToWslPath as normalizePathInput', async () => {
      const { normalizePathInput } = await import('./settings.js');
      expect(normalizePathInput('C:\\Users\\you\\__raws', 'linux')).toBe('/mnt/c/Users/you/__raws');
    });

    it('re-exports wslToWindowsPath as toWindowsPath', async () => {
      const { toWindowsPath } = await import('./settings.js');
      expect(toWindowsPath('/mnt/c/Users/you/__raws')).toBe('C:\\Users\\you\\__raws');
    });
  });
});
