import fs from 'fs';
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

const LOG_DIR = path.resolve('logs');
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

function writeToFile(logLine: string): void {
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, logLine, 'utf8');
  } catch (err) {
    console.error('Failed to write to log file:', err);
  }
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
