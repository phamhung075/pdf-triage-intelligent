import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { EventEmitter } from 'events';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  moduleName: string;
  message: string;
  filename?: string;
  meta?: any;
  line: string;
}

export interface DocumentLogSession {
  filename: string;
  startedAt: string;
  updatedAt: string;
  logsCount: number;
  status: 'COMPLETED' | 'FAILED' | 'IN_PROGRESS';
  category?: string;
  subcategory?: string;
  decisionReason?: string;
  logs: LogEntry[];
}

// Resolved here rather than imported from settings.ts on purpose: logger sits underneath most of
// the codebase, and importing settings would make every test that mocks settings fail on a missing
// export. The rule is the same one settings.ts applies — honour PDF_TRIAGE_DATA_DIR, else derive
// the app root from this file's own location (src/infrastructure/ and dist/infrastructure/ are both
// exactly two levels down). Never process.cwd(): a packaged app's cwd is wherever Windows launched
// it from, so `path.resolve('logs')` wrote the log somewhere arbitrary.
const LOG_ROOT = process.env.PDF_TRIAGE_DATA_DIR
  ? path.resolve(process.env.PDF_TRIAGE_DATA_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// PDF_TRIAGE_LOG_DIR points the log file somewhere else without moving the rest of the data dir.
// It exists because the test suite had no way to opt out: every suite that exercises triage,
// repair, relocalize or the image pipeline calls the real logger, which appended to the developer's
// production logs/triage_debug.log — a measured 186 lines per `npm test` run, carrying temp-dir
// paths and synthetic errors ("vision model unreachable") that are indistinguishable from real
// pipeline failures when someone later greps the log to diagnose a document. Redirecting via
// PDF_TRIAGE_DATA_DIR was not an option: several suites deliberately assert on DATA_DIR falling
// back to BASE_DIR the way a git checkout does. vitest.setup.ts sets this to a temp directory;
// in production it is unset and nothing changes.
const LOG_DIR = process.env.PDF_TRIAGE_LOG_DIR
  ? path.resolve(process.env.PDF_TRIAGE_LOG_DIR)
  : path.join(LOG_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'triage_debug.log');

export const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(100);

const MAX_BUFFER_SIZE = 1000;
let logIdCounter = 1;
const logBuffer: LogEntry[] = [];

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

export function extractFilenameFromLog(entry: { message: string; meta?: any; filename?: string }): string | null {
  if (entry.filename) return path.basename(entry.filename);

  if (entry.meta && typeof entry.meta === 'object') {
    for (const key of ['filename', 'filePath', 'originalPath', 'original_path', 'from', 'to', 'newPath', 'path']) {
      const val = entry.meta[key];
      if (typeof val === 'string' && val.toLowerCase().includes('.pdf')) {
        return path.basename(val);
      }
    }
  }

  if (entry.message) {
    const match = entry.message.match(/(?:[a-zA-Z]:[\\/][^:*?"<>|\r\n]+\.pdf|[^\s\\/:*?"<>|\r\n\['"]+(?:\s+[^\s\\/:*?"<>|\r\n\['"]+)*\.pdf)/i);
    if (match) {
      const clean = match[0].replace(/^['"`\s]+|['"`\s]+$/g, '');
      return path.basename(clean);
    }
  }

  return null;
}

function formatLogMessage(level: LogEntry['level'], moduleName: string, message: string, meta?: any, filename?: string): { line: string; entry: LogEntry } {
  const timestamp = new Date().toISOString();
  let metaStr = '';
  if (meta !== undefined) {
    try {
      metaStr = typeof meta === 'object' ? ` | Meta: ${JSON.stringify(meta)}` : ` | Meta: ${meta}`;
    } catch {
      metaStr = ` | Meta: [Circular]`;
    }
  }

  const resolvedFilename = filename || extractFilenameFromLog({ message, meta }) || undefined;
  const filePrefix = resolvedFilename ? ` [${resolvedFilename}]` : '';
  const line = `[${timestamp}] [${level}] [${moduleName}]${filePrefix} ${message}${metaStr}\n`;
  const entry: LogEntry = {
    id: logIdCounter++,
    timestamp,
    level,
    moduleName,
    message,
    filename: resolvedFilename,
    meta,
    line
  };

  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.shift();
  }

  logEmitter.emit('log', entry);
  return { line, entry };
}

// Size-based rotation. Before this existed the log was append-only forever: the developer's
// triage_debug.log had reached 12.8MB / 45k lines, and the packaged desktop app had no way to
// reclaim it either. Rotation keeps the recent history that actually gets grepped while bounding
// disk use. Both knobs are env-overridable because the desktop build and a headless server want
// different budgets; 0 bytes disables rotation entirely (append-only, the old behavior).
const MAX_LOG_BYTES = (() => {
  const raw = Number(process.env.PDF_TRIAGE_LOG_MAX_BYTES);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5 * 1024 * 1024;
})();
const LOG_RETAIN = (() => {
  const raw = Number(process.env.PDF_TRIAGE_LOG_RETAIN);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
})();

// Tracked in memory so the common path is a plain append: stat-ing the file on every single log
// line would put a syscall in front of a function called thousands of times per scan. null means
// "not yet known" and triggers one stat on the next write.
let currentLogBytes: number | null = null;

export function rotateLogIfNeeded(incomingBytes: number): void {
  if (MAX_LOG_BYTES === 0) return;

  if (currentLogBytes === null) {
    try {
      currentLogBytes = fs.statSync(LOG_FILE).size;
    } catch {
      currentLogBytes = 0; // no file yet
    }
  }

  if (currentLogBytes + incomingBytes <= MAX_LOG_BYTES) return;

  try {
    // Drop the oldest generation, then shift each one down: .log.2 -> .log.3, .log.1 -> .log.2, etc.
    const oldest = `${LOG_FILE}.${LOG_RETAIN}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let i = LOG_RETAIN - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${LOG_FILE}.${i + 1}`);
    }
    if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    currentLogBytes = 0;
  } catch (err) {
    // A failed rotation must never lose the line being written — fall through and keep appending
    // to whatever file is still there rather than throwing out of logger.info().
    console.error('Failed to rotate log file:', err);
    currentLogBytes = 0;
  }
}

function writeToFile(logLine: string): void {
  try {
    ensureLogDir();
    const bytes = Buffer.byteLength(logLine, 'utf8');
    rotateLogIfNeeded(bytes);
    fs.appendFileSync(LOG_FILE, logLine, 'utf8');
    currentLogBytes = (currentLogBytes ?? 0) + bytes;
  } catch (err) {
    console.error('Failed to write to log file:', err);
  }
}

// Test seam: lets a suite assert rotation without reaching into module state.
export function __getLogFilePathForTests(): string {
  return LOG_FILE;
}

export function getRecentLogs(limit = 300): LogEntry[] {
  return logBuffer.slice(-limit);
}

export function getGroupedSessionLogs(): DocumentLogSession[] {
  const map = new Map<string, DocumentLogSession>();

  for (const entry of logBuffer) {
    const fn = entry.filename || extractFilenameFromLog(entry);

    if (!fn) continue;

    let session = map.get(fn);
    if (!session) {
      session = {
        filename: fn,
        startedAt: entry.timestamp,
        updatedAt: entry.timestamp,
        logsCount: 0,
        status: 'IN_PROGRESS',
        logs: []
      };
      map.set(fn, session);
    }

    session.logs.push(entry);
    session.logsCount = session.logs.length;
    session.updatedAt = entry.timestamp;

    if (entry.meta && typeof entry.meta === 'object') {
      if (entry.meta.category || entry.meta.categorie) session.category = entry.meta.category || entry.meta.categorie;
      if (entry.meta.subcategory || entry.meta.subcategorie) session.subcategory = entry.meta.subcategory || entry.meta.subcategorie;
      if (entry.meta.reason) session.decisionReason = entry.meta.reason;
    }

    if (entry.level === 'ERROR' || entry.message.includes('FAILED') || entry.message.includes('BLOCKED')) {
      session.status = 'FAILED';
    } else if (entry.message.includes('COMPLETED') || entry.message.includes('MOVED') || entry.message.includes('Classification success') || entry.message.includes('Relocalized')) {
      if (session.status !== 'FAILED') session.status = 'COMPLETED';
    }
  }

  return Array.from(map.values()).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export const logger = {
  debug(moduleName: string, message: string, meta?: any, filename?: string): void {
    const { line } = formatLogMessage('DEBUG', moduleName, message, meta, filename);
    console.log(`\x1b[36m[DEBUG]\x1b[0m \x1b[35m[${moduleName}]\x1b[0m ${message}`, meta ? meta : '');
    writeToFile(line);
  },
  info(moduleName: string, message: string, meta?: any, filename?: string): void {
    const { line } = formatLogMessage('INFO', moduleName, message, meta, filename);
    console.log(`\x1b[32m[INFO]\x1b[0m \x1b[35m[${moduleName}]\x1b[0m ${message}`, meta ? meta : '');
    writeToFile(line);
  },
  warn(moduleName: string, message: string, meta?: any, filename?: string): void {
    const { line } = formatLogMessage('WARN', moduleName, message, meta, filename);
    console.warn(`\x1b[33m[WARN]\x1b[0m \x1b[35m[${moduleName}]\x1b[0m ${message}`, meta ? meta : '');
    writeToFile(line);
  },
  error(moduleName: string, message: string, meta?: any, filename?: string): void {
    const { line } = formatLogMessage('ERROR', moduleName, message, meta, filename);
    console.error(`\x1b[31m[ERROR]\x1b[0m \x1b[35m[${moduleName}]\x1b[0m ${message}`, meta ? meta : '');
    writeToFile(line);
  },
  forDocument(filename: string) {
    const cleanName = path.basename(filename);
    return {
      debug: (moduleName: string, message: string, meta?: any) => logger.debug(moduleName, message, meta, cleanName),
      info: (moduleName: string, message: string, meta?: any) => logger.info(moduleName, message, meta, cleanName),
      warn: (moduleName: string, message: string, meta?: any) => logger.warn(moduleName, message, meta, cleanName),
      error: (moduleName: string, message: string, meta?: any) => logger.error(moduleName, message, meta, cleanName)
    };
  }
};
