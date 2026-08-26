import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// logger.ts had no test file at all, which is how three defects survived in it: unconditional
// writes into the developer's real log during `npm test`, unbounded growth (12.8MB / 45k lines
// before rotation existed), and a filename extractor that splits one document across several
// sessions. logger.ts resolves its paths and knobs at module load, so every case here sets the
// env first and then imports through vi.resetModules().
let tempDir: string;
// vitest reuses a worker across test files, and these cases overwrite process.env for the whole
// process. Without capturing and restoring the values vitest.setup.ts installed, the next file to
// run in the same worker would inherit this suite's (already deleted) temp log dir and its tiny
// rotation cap — which is exactly the kind of cross-file bleed that makes a suite flaky.
let savedEnv: Record<string, string | undefined>;

async function freshLogger(env: Record<string, string> = {}) {
  vi.resetModules();
  process.env.PDF_TRIAGE_LOG_DIR = tempDir;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return import('./logger.js');
}

beforeEach(() => {
  savedEnv = {
    PDF_TRIAGE_LOG_DIR: process.env.PDF_TRIAGE_LOG_DIR,
    PDF_TRIAGE_LOG_MAX_BYTES: process.env.PDF_TRIAGE_LOG_MAX_BYTES,
    PDF_TRIAGE_LOG_RETAIN: process.env.PDF_TRIAGE_LOG_RETAIN,
  };
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules(); // drop the logger instance bound to the now-deleted tempDir
});

describe('log file location', () => {
  it('honours PDF_TRIAGE_LOG_DIR so a test run never touches the production log', async () => {
    const { logger, __getLogFilePathForTests } = await freshLogger();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('TRIAGE', 'hello from a test');

    const logFile = __getLogFilePathForTests();
    expect(path.dirname(logFile)).toBe(path.resolve(tempDir));
    expect(fs.readFileSync(logFile, 'utf8')).toContain('hello from a test');
  });
});

describe('log rotation', () => {
  it('rotates once the file would exceed the size cap, preserving the old content as .1', async () => {
    const { logger, __getLogFilePathForTests } = await freshLogger({ PDF_TRIAGE_LOG_MAX_BYTES: '400' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const logFile = __getLogFilePathForTests();

    logger.info('TRIAGE', 'FIRST_GENERATION_MARKER ' + 'x'.repeat(300));
    expect(fs.existsSync(`${logFile}.1`)).toBe(false); // still under the cap

    logger.info('TRIAGE', 'SECOND_GENERATION_MARKER ' + 'y'.repeat(300));

    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toContain('FIRST_GENERATION_MARKER');
    expect(fs.readFileSync(logFile, 'utf8')).toContain('SECOND_GENERATION_MARKER');
    // The live file restarted, so it holds only the new line.
    expect(fs.readFileSync(logFile, 'utf8')).not.toContain('FIRST_GENERATION_MARKER');
  });

  it('keeps at most PDF_TRIAGE_LOG_RETAIN generations and discards the oldest', async () => {
    const { logger, __getLogFilePathForTests } = await freshLogger({
      PDF_TRIAGE_LOG_MAX_BYTES: '300',
      PDF_TRIAGE_LOG_RETAIN: '2',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const logFile = __getLogFilePathForTests();

    for (let i = 1; i <= 5; i++) logger.info('TRIAGE', `GEN_${i} ` + 'z'.repeat(250));

    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    expect(fs.existsSync(`${logFile}.2`)).toBe(true);
    expect(fs.existsSync(`${logFile}.3`)).toBe(false); // capped at 2 generations
  });

  it('never rotates when the cap is disabled with 0', async () => {
    const { logger, __getLogFilePathForTests } = await freshLogger({ PDF_TRIAGE_LOG_MAX_BYTES: '0' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const logFile = __getLogFilePathForTests();

    for (let i = 0; i < 20; i++) logger.info('TRIAGE', 'append forever ' + 'q'.repeat(200));

    expect(fs.existsSync(`${logFile}.1`)).toBe(false);
    expect(fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)).toHaveLength(20);
  });

  it('keeps writing the line even if rotation itself fails', async () => {
    const { logger, __getLogFilePathForTests } = await freshLogger({ PDF_TRIAGE_LOG_MAX_BYTES: '200' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logFile = __getLogFilePathForTests();

    logger.info('TRIAGE', 'first ' + 'a'.repeat(200));
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EBUSY'); });

    logger.info('TRIAGE', 'MUST_STILL_BE_WRITTEN');

    expect(errSpy).toHaveBeenCalledWith('Failed to rotate log file:', expect.any(Error));
    expect(fs.readFileSync(logFile, 'utf8')).toContain('MUST_STILL_BE_WRITTEN');
  });
});
