import express from 'express';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { exec, spawn } from 'child_process';
import { Ollama } from 'ollama';
import { z } from 'zod';
import { CONFIG, BASE_DIR, DATA_DIR, updateConfig, isFirstRun, ensureDirectoriesExist } from '../settings.js';
import { openDirectory, revealInFileManager, openInChrome } from '../os-open.js';
import { getAllDocuments, getDocumentById, updateDocumentRecord, getDb, getCategorySubcategoryStats, getBlockedFile, getAllBlockedFiles } from '../db/database.js';
import { checkModelCanGenerate } from '../ollama-client.js';
import { takeOverPaddleOcrServer } from '../paddleocr-client.js';
import { getCategoriesConfig, saveCategoriesConfig, setOnCategoryCreatedCallback } from '../categories-store.js';
import { syncJSONRegistry } from '../json-registry.js';
import { clearRegistryAndMoveArchiveToRaws } from '../../application/clear-registry.js';
import { repairRegistry } from '../../application/repair-registry.js';
import { runTriageScan } from '../../application/triage-scan.js';
import { relocalizeFileIfNeeded, findActualFileOnDisk, reclassifyAndRelocalizeDocument, ensureCategoryAndSubcategoryExist, deleteDocumentAndMoveToTrash } from '../../application/relocalize-document.js';
import { getPDFsRecursively } from '../pdf-scanner.js';
import { isForbiddenSubcategory, isPathInsideDir, mergeSubcategoryInTaxonomy } from '../../domain/taxonomy.js';
import { logger, getRecentLogs, getGroupedSessionLogs, logEmitter } from '../logger.js';
import { UpdateDocumentSchema, SystemSettingsSchema, CategoriesConfigSchema } from '../../domain/document.schema.js';
import { readActiveLockHolder, acquireProcessLock, killProcessOnPort } from '../pid-lock.js';
import { getManualDecisions } from '../manual-decisions-store.js';
import { PDFDocument } from 'pdf-lib';
import { getTaskState, startTask, updateTaskProgress, finishTask, failTask, setTaskBroadcaster, resetTaskState } from './task-state.js';
import { processChatQuery } from '../../application/ai-chat-assistant.js';

/**
 * Resolves a caller-supplied path and asserts it is inside a managed directory.
 *
 * Every path this server legitimately touches lives under INPUT_DIR (__raws) or OUTPUT_ROOT_DIR
 * (__archive). Endpoints that took a path straight from the request body and only checked
 * existsSync would happily read any file the Node process can — an SSH key, another app's .env —
 * and, for the PDF tools, write a derivative of it into __raws, where the auto-watcher then
 * classifies and archives it into the searchable registry. Returns null when the path escapes.
 */
function resolveManagedPath(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) return null;
  const absPath = path.resolve(candidate);
  if (!isPathInsideDir(absPath, CONFIG.INPUT_DIR) && !isPathInsideDir(absPath, CONFIG.OUTPUT_ROOT_DIR)) {
    return null;
  }
  return absPath;
}

// Mirrors IMAGE_EXTENSIONS in application/convert-image-document.ts — anything the vision
// pipeline can turn into a page. Kept as its own set so the HTTP layer validates the upload
// before writing it, rather than letting an unsupported file sit in the incoming folder failing
// conversion on every scan tick.
const IMPORTABLE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff']);

export function createWebServer(): express.Express {
  const app = express();

  // No CORS middleware: the frontend is served from this same Express instance (same-origin),
  // so it never needs it. This server has no authentication layer — Access-Control-Allow-Origin:
  // '*' (the previous `cors()` default) would let any webpage the user has open in another tab
  // read this entire API cross-origin (documents, summaries, raw text) via fetch().
  app.use(express.json());

  setTaskBroadcaster((evt) => {
    broadcastTriageEvent(evt);
  });

  setOnCategoryCreatedCallback(() => {
    broadcastTriageEvent({ type: 'CATEGORIES_UPDATED' });
  });

  const publicDir = path.join(BASE_DIR, 'public');
  if (fs.existsSync(publicDir)) {
    // This is a local dev tool, not a CDN-scale site — never let the browser cache
    // app.js/style.css/index.html on disk. The static ?v=18 query param in index.html
    // relied on someone remembering to bump it on every edit (nobody did, twice, in one
    // session), so a stale tab could silently keep running pre-fix JS after a server
    // restart picked up new code. no-store removes the failure mode outright.
    app.use(express.static(publicDir, {
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    }));
  }

  // Shared guard: prevents manual scan, the 10s auto-watcher, repair, and clear-registry
  // from ever running concurrently against the same __raws/__archive files in this process.
  let isAutoScanning = false;
  // When the user manually stops a scan, suppress auto-watcher for 60 seconds.
  let manualStopCooldownUntil = 0;

  // Hot Reload / Live Reload SSE Endpoint
  const liveReloadClients: express.Response[] = [];
  app.get('/api/dev/livereload', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    liveReloadClients.push(res);

    const cleanup = () => {
      const idx = liveReloadClients.indexOf(res);
      if (idx !== -1) liveReloadClients.splice(idx, 1);
    };
    req.on('close', cleanup);
    // Without this, a write to an abruptly-reset socket (network drop, sleep, tab
    // killed) throws an unhandled 'error' event — which crashes the whole process.
    res.on('error', cleanup);
  });

  if (fs.existsSync(publicDir)) {
    fs.watch(publicDir, { recursive: true }, () => {
      liveReloadClients.forEach(client => {
        client.write('data: reload\n\n');
      });
    });
  }

  // Open location in Windows Explorer endpoint. All launcher logic (platform branching and the
  // WSL->Windows path conversion) lives in src/infrastructure/os-open.ts — see its header for why.
  app.post('/api/open-location', (req, res) => {
    try {
      const OpenLocationSchema = z.object({ targetPath: z.string().min(1) });
      const { targetPath } = OpenLocationSchema.parse(req.body);

      // Existence/stat checks run against the POSIX path; os-open.ts hands Windows programs the
      // Windows form (a POSIX /mnt path makes Windows Explorer fall back to the user's Documents).
      const normalized = path.normalize(targetPath);

      if (fs.existsSync(normalized)) {
        const stat = fs.statSync(normalized);
        const launch = stat.isDirectory() ? openDirectory(normalized) : revealInFileManager(normalized);
        if (launch) spawn(launch.cmd, launch.args, { detached: true, stdio: 'ignore' }).unref();
        res.json({ message: 'Windows Explorer opened', path: normalized });
      } else {
        const parentDir = path.dirname(normalized);
        if (fs.existsSync(parentDir)) {
          const launch = openDirectory(parentDir);
          if (launch) spawn(launch.cmd, launch.args, { detached: true, stdio: 'ignore' }).unref();
          res.json({ message: 'Opened parent directory', path: parentDir });
        } else {
          res.status(404).json({ error: `Path does not exist: ${normalized}` });
        }
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Open PDF in Google Chrome endpoint using child_process.exec
  app.post('/api/open-chrome', (req, res) => {
    try {
      const OpenChromeSchema = z.object({ targetPath: z.string().min(1) });
      const { targetPath } = OpenChromeSchema.parse(req.body);

      const normalized = path.normalize(targetPath);

      if (fs.existsSync(normalized)) {
        // Executable lookup (incl. WSL /mnt/c probes) and the WSL->Windows path conversion live
        // in os-open.ts — Chrome is a Windows program and cannot open a POSIX /mnt path.
        const launch = openInChrome(normalized);
        if (!launch) {
          res.status(500).json({ error: 'Chrome executable not found' });
          return;
        }

        // Launch Chrome directly with the file path as an argv entry — Chrome's own
        // single-instance IPC forwards this to the existing window as a new tab, so the old
        // `start "" "..." "..."` shell wrapper wasn't needed for that behavior in the first
        // place. Security: normalized is attacker-controllable request-body input (only
        // constrained by z.string().min(1)), and Windows filenames can legally contain shell
        // metacharacters (&, %, (, ), ^) that survive this app's own filename sanitization —
        // spawn() with an argument array never invokes a shell, so none of that can matter here.
        // Fire-and-forget, matching every other GUI-helper spawn() in this file (open-location
        // below) — none of them wait for a spawn/error event before responding.
        spawn(launch.cmd, launch.args, { detached: true, stdio: 'ignore' }).unref();
        res.json({ success: true, message: 'Opened document in Chrome tab', path: normalized });
      } else {
        res.status(404).json({ error: `File path does not exist: ${normalized}` });
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Ollama status check endpoint
  app.get('/api/ollama/status', async (req, res) => {
    const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
    try {
      const list = await ollama.list();
      const modelExists = list.models.some(m => m.name.includes(CONFIG.OLLAMA_MODEL));
      const health = modelExists ? await checkModelCanGenerate(CONFIG.OLLAMA_MODEL) : { ok: false, error: 'model not found locally' };
      res.json({
        online: true,
        model: CONFIG.OLLAMA_MODEL,
        host: CONFIG.OLLAMA_HOST,
        modelsCount: list.models.length,
        models: list.models.map(m => m.name),
        modelExists,
        modelCanGenerate: health.ok,
        modelError: health.ok ? undefined : health.error
      });
    } catch (err: any) {
      res.json({
        online: false,
        model: CONFIG.OLLAMA_MODEL,
        host: CONFIG.OLLAMA_HOST,
        modelsCount: 0,
        models: [],
        error: err.message
      });
    }
  });

  // Dedicated endpoint to fetch all locally installed Ollama models
  app.get('/api/ollama/models', async (req, res) => {
    const ollamaHost = (req.query.host as string) || CONFIG.OLLAMA_HOST;
    const ollama = new Ollama({ host: ollamaHost });
    try {
      const list = await ollama.list();
      const modelNames = list.models.map(m => m.name);
      res.json({ online: true, models: modelNames });
    } catch (err: any) {
      res.json({ online: false, models: [], error: err.message });
    }
  });

  // Endpoint to start/spawn local Ollama serve process
  app.post('/api/ollama/start', (req, res) => {
    try {
      exec('ollama serve', { windowsHide: true }, (err) => {
        if (err) {
          console.warn('Ollama serve launch info:', err.message);
        }
      });
      res.json({ message: 'Ollama serve launch initiated' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Endpoint to restart the server (useful when Ollama is disconnected)
  app.post('/api/server/restart', (req, res) => {
    res.json({ message: 'Server restarting...' });
    // Give the response a moment to be sent before exiting.
    setTimeout(() => {
      console.log('🛑 Server restart requested – exiting process');
      process.exit(0);
    }, 500);
  });

  // Get overall active task progress state
  app.get('/api/triage/status', (req, res) => {
    res.json(getTaskState());
  });

  // Repair registry endpoint
  app.post('/api/registry/repair', async (req, res) => {
    if (isAutoScanning) {
      res.status(409).json({ error: 'A scan/repair/clear operation is already in progress. Try again shortly.' });
      return;
    }
    isAutoScanning = true;
    startTask('REPAIR', 0, 'Initializing registry repair & relocalization...');
    try {
      const result = await repairRegistry((evt) => {
        if (evt.type === 'REPAIR_STARTED') {
          updateTaskProgress(0, '', 'REPAIRING', evt.message, evt.totalFiles);
        } else if (evt.type === 'FILE_PROGRESS' || evt.type === 'FILE_COMPLETED') {
          updateTaskProgress(evt.scannedCount || evt.processedCount || 0, evt.filename, evt.stage, evt.message, evt.totalFiles);
        }
        broadcastTriageEvent(evt);
      });
      finishTask(result, `Registry repair completed. Repaired ${result.repairedCount}, updated ${result.updatedCount}, relocalized ${result.relocalizedCount} file(s).`);
      broadcastTriageEvent({ type: 'REPAIR_COMPLETED', ...result });
      broadcastTriageEvent({ type: 'REGISTRY_UPDATED', action: 'REPAIR' });
      res.json({ message: 'Registry repair completed successfully', ...result });
    } catch (err: any) {
      failTask(err.message);
      res.status(500).json({ error: err.message });
    } finally {
      isAutoScanning = false;
    }
  });

  // Get system config
  // Setup state for the first-run screen. Kept separate from GET /api/config because the dashboard
  // asks for it on every load, before it knows whether the app is usable at all — and because
  // CONFIG always has *some* value for input_dir/output_root_dir (a default under DATA_DIR), so
  // reading those cannot tell you whether the user ever chose them.
  app.get('/api/config/setup-state', (req, res) => {
    try {
      // Suggested folders for a brand-new install. Deliberately NOT CONFIG.INPUT_DIR /
      // OUTPUT_ROOT_DIR: unconfigured, those resolve under DATA_DIR, which for a packaged app is
      // %APPDATA% — a hidden system folder nobody wants their documents living in. Somewhere under
      // the user's own Documents is what a person would actually pick.
      const documents = path.join(os.homedir(), 'Documents', 'Smart PDF Triage');
      const firstRun = isFirstRun();

      res.json({
        configured: !firstRun,
        dataDir: DATA_DIR,
        defaults: {
          // On first run offer the friendly suggestion; afterwards report what is really in use.
          input_dir: firstRun ? path.join(documents, 'Incoming') : CONFIG.INPUT_DIR,
          output_root_dir: firstRun ? path.join(documents, 'Archive') : CONFIG.OUTPUT_ROOT_DIR,
          language: CONFIG.LANGUAGE,
          ollama_host: CONFIG.OLLAMA_HOST,
          ollama_model: CONFIG.OLLAMA_MODEL,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/config', (req, res) => {
    try {
      res.json({
        language: CONFIG.LANGUAGE,
        input_dir: CONFIG.INPUT_DIR,
        output_root_dir: CONFIG.OUTPUT_ROOT_DIR,
        ollama_model: CONFIG.OLLAMA_MODEL,
        ollama_host: CONFIG.OLLAMA_HOST,
        personal_name_denylist: CONFIG.PERSONAL_NAME_DENYLIST
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get system storage & multi-format stats (taille & format)
  app.get('/api/system/stats', (req, res) => {
    try {
      const getDirStatsSync = (dirPath: string) => {
        let count = 0;
        let bytes = 0;
        const formatBreakdown: Record<string, { count: number; bytes: number }> = {
          pdf: { count: 0, bytes: 0 },
          image: { count: 0, bytes: 0 },
          text: { count: 0, bytes: 0 },
          word: { count: 0, bytes: 0 },
          excel: { count: 0, bytes: 0 }
        };
        if (!fs.existsSync(dirPath)) return { count, bytes, formatBreakdown };

        const walk = (currentDir: string) => {
          try {
            const entries = fs.readdirSync(currentDir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(currentDir, entry.name);
              if (entry.isDirectory()) {
                walk(fullPath);
              } else if (entry.isFile()) {
                try {
                  const stat = fs.statSync(fullPath);
                  count++;
                  bytes += stat.size;
                  const ext = path.extname(entry.name).toLowerCase();
                  let key = 'pdf';
                  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff'].includes(ext)) key = 'image';
                  else if (['.txt', '.md', '.csv', '.log', '.json'].includes(ext)) key = 'text';
                  else if (['.docx', '.doc'].includes(ext)) key = 'word';
                  else if (['.xlsx', '.xls'].includes(ext)) key = 'excel';
                  
                  if (formatBreakdown[key]) {
                    formatBreakdown[key].count++;
                    formatBreakdown[key].bytes += stat.size;
                  }
                } catch {}
              }
            }
          } catch {}
        };
        walk(dirPath);
        return { count, bytes, formatBreakdown };
      };

      const formatBytes = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
      };

      const rawStats = getDirStatsSync(CONFIG.INPUT_DIR);
      const archiveStats = getDirStatsSync(CONFIG.OUTPUT_ROOT_DIR);
      
      let dbBytes = 0;
      if (fs.existsSync(CONFIG.DB_PATH)) {
        try { dbBytes = fs.statSync(CONFIG.DB_PATH).size; } catch {}
      }

      const totalFiles = rawStats.count + archiveStats.count;
      const totalBytes = rawStats.bytes + archiveStats.bytes;

      const formatBreakdown = {
        pdf: { count: rawStats.formatBreakdown.pdf.count + archiveStats.formatBreakdown.pdf.count, bytes: rawStats.formatBreakdown.pdf.bytes + archiveStats.formatBreakdown.pdf.bytes },
        image: { count: rawStats.formatBreakdown.image.count + archiveStats.formatBreakdown.image.count, bytes: rawStats.formatBreakdown.image.bytes + archiveStats.formatBreakdown.image.bytes },
        text: { count: rawStats.formatBreakdown.text.count + archiveStats.formatBreakdown.text.count, bytes: rawStats.formatBreakdown.text.bytes + archiveStats.formatBreakdown.text.bytes },
        word: { count: rawStats.formatBreakdown.word.count + archiveStats.formatBreakdown.word.count, bytes: rawStats.formatBreakdown.word.bytes + archiveStats.formatBreakdown.word.bytes },
        excel: { count: rawStats.formatBreakdown.excel.count + archiveStats.formatBreakdown.excel.count, bytes: rawStats.formatBreakdown.excel.bytes + archiveStats.formatBreakdown.excel.bytes },
      };

      res.json({
        raws: { count: rawStats.count, bytes: rawStats.bytes, sizeFormatted: formatBytes(rawStats.bytes) },
        archive: { count: archiveStats.count, bytes: archiveStats.bytes, sizeFormatted: formatBytes(archiveStats.bytes) },
        database: { bytes: dbBytes, sizeFormatted: formatBytes(dbBytes) },
        total: { count: totalFiles, bytes: totalBytes, sizeFormatted: formatBytes(totalBytes) },
        formatBreakdown: {
          pdf: { ...formatBreakdown.pdf, sizeFormatted: formatBytes(formatBreakdown.pdf.bytes) },
          image: { ...formatBreakdown.image, sizeFormatted: formatBytes(formatBreakdown.image.bytes) },
          text: { ...formatBreakdown.text, sizeFormatted: formatBytes(formatBreakdown.text.bytes) },
          word: { ...formatBreakdown.word, sizeFormatted: formatBytes(formatBreakdown.word.bytes) },
          excel: { ...formatBreakdown.excel, sizeFormatted: formatBytes(formatBreakdown.excel.bytes) },
        }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update system config
  app.put('/api/config', (req, res) => {
    try {
      const validated = SystemSettingsSchema.parse(req.body);
      updateConfig(validated);
      res.json({
        message: 'System settings updated successfully',
        config: {
          language: CONFIG.LANGUAGE,
          input_dir: CONFIG.INPUT_DIR,
          output_root_dir: CONFIG.OUTPUT_ROOT_DIR,
          ollama_model: CONFIG.OLLAMA_MODEL,
          ollama_host: CONFIG.OLLAMA_HOST,
          personal_name_denylist: CONFIG.PERSONAL_NAME_DENYLIST
        }
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Get recent terminal log history
  app.get('/api/logs/recent', (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 300;
      const logs = getRecentLogs(limit);
      res.json({ logs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get logs grouped by document processing session
  app.get('/api/logs/sessions', (req, res) => {
    try {
      const sessions = getGroupedSessionLogs();
      res.json({ total: sessions.length, sessions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Live SSE stream for real-time terminal logs
  app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Deliberately NO Access-Control-Allow-Origin — see the no-CORS rationale at the top of
    // createWebServer(). This stream carries original filenames, resolved entity categories and
    // decision traces; a wildcard here would let any page open in another tab read all of it.

    // Send initial snapshot
    const initialLogs = getRecentLogs(100);
    res.write(`data: ${JSON.stringify({ type: 'INIT', logs: initialLogs })}\n\n`);

    const logListener = (entry: any) => {
      res.write(`data: ${JSON.stringify({ type: 'LOG', entry })}\n\n`);
    };

    logEmitter.on('log', logListener);

    req.on('close', () => {
      logEmitter.removeListener('log', logListener);
      res.end();
    });
  });

  // Get categories with dynamic document counters from DB
  app.get('/api/categories', async (req, res) => {
    try {
      const config = getCategoriesConfig();
      const stats = await getCategorySubcategoryStats();

      const categoriesWithStats = config.categories.map(cat => {
        const catIdLower = cat.id.toLowerCase();
        const catCount = stats.categoryCounts[catIdLower] || 0;
        const subMap = stats.subcategoryCounts[catIdLower] || {};

        const subcategoriesWithStats = (cat.subcategories || []).map(sub => ({
          ...sub,
          count: subMap[sub.id.toLowerCase()] || 0
        }));

        // Dynamically include subcategories present in DB that are not yet in categories.json
        Object.keys(subMap).forEach(subId => {
          if (subId !== 'general' && !/^\d{4}$/.test(subId) && !subcategoriesWithStats.some(s => s.id.toLowerCase() === subId)) {
            const formattedName = subId.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            subcategoriesWithStats.push({
              id: subId,
              name: formattedName,
              aliases: [subId],
              count: subMap[subId]
            });
          }
        });

        return {
          ...cat,
          count: catCount,
          subcategories: subcategoriesWithStats
        };
      });

      res.json({
        totalDocuments: stats.total,
        categories: categoriesWithStats
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // List all files currently held in __raws/blocked_files, with why each was blocked
  // (no digital text/OCR text extracted, or no specific subcategory could be determined).
  app.get('/api/blocked-files', async (req, res) => {
    try {
      const files = await getAllBlockedFiles();
      res.json({ total: files.length, files });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get full audit log of all human/manual move & relocalize decisions for reference
  app.get('/api/manual-decisions', async (req, res) => {
    try {
      const decisions = await getManualDecisions();
      res.json({ total: decisions.length, decisions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update categories
  app.put('/api/categories', (req, res) => {
    try {
      const validated = CategoriesConfigSchema.parse(req.body);
      saveCategoriesConfig(validated.categories);
      broadcastTriageEvent({ type: 'CATEGORIES_UPDATED' });
      res.json({
        message: 'Categories updated successfully',
        categories: validated.categories
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Rename a subcategory across all documents & relocalize physical files on disk
  app.post('/api/subcategories/rename', async (req, res) => {
    try {
      const { category, oldSubcategory, newSubcategory } = req.body || {};
      if (!category || !oldSubcategory || !newSubcategory) {
        return res.status(400).json({ error: 'Missing required parameters: category, oldSubcategory, newSubcategory' });
      }

      const cleanOld = oldSubcategory.toLowerCase().trim();
      const cleanNew = newSubcategory.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '_');

      if (cleanOld === cleanNew) {
        return res.json({ message: 'Subcategory name unchanged', count: 0 });
      }

      // Rename and merge are the same gesture; mergeSubcategoryInTaxonomy handles both, including
      // the case where the destination already exists (which would otherwise leave two entries
      // sharing one id). Unit-tested in src/domain/taxonomy.test.ts.
      const config = getCategoriesConfig();
      saveCategoriesConfig(mergeSubcategoryInTaxonomy(config.categories, category, cleanOld, cleanNew));

      const allDocs = await getAllDocuments();
      const matchingDocs = allDocs.filter(d => d.category.toLowerCase() === category.toLowerCase().trim() && (d.subcategory || '').toLowerCase() === cleanOld);

      let relocalizedCount = 0;
      for (const doc of matchingDocs) {
        const actualPath = findActualFileOnDisk(doc);
        if (actualPath && fs.existsSync(actualPath)) {
          const { newPath } = relocalizeFileIfNeeded(actualPath, doc.category, cleanNew, doc.date);
          await updateDocumentRecord(doc.id, {
            subcategory: cleanNew,
            new_path: newPath,
            status: 'MOVED'
          });
          relocalizedCount++;
        } else {
          await updateDocumentRecord(doc.id, { subcategory: cleanNew });
        }
      }

      await syncJSONRegistry();
      broadcastTriageEvent({ type: 'REGISTRY_UPDATED' });
      broadcastTriageEvent({ type: 'CATEGORIES_UPDATED' });

      res.json({
        message: `Successfully renamed subcategory '${cleanOld}' ➔ '${cleanNew}' and relocalized ${relocalizedCount} physical file(s).`,
        count: relocalizedCount
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get documents list with search/category/subcategory filtering
  app.get('/api/documents', async (req, res) => {
    try {
      const docs = await getAllDocuments();
      const search = (req.query.q as string || '').toLowerCase();
      const category = (req.query.category as string || '').toLowerCase();
      const subcategory = (req.query.subcategory as string || '').toLowerCase();

      const filtered = docs.filter(doc => {
        const matchesCategory = !category || doc.category.toLowerCase() === category;
        const matchesSubcategory = !subcategory || (doc.subcategory && doc.subcategory.toLowerCase() === subcategory);
        const matchesQuery = !search ||
          doc.title.toLowerCase().includes(search) ||
          (doc.original_filename && doc.original_filename.toLowerCase().includes(search)) ||
          (doc.original_path && doc.original_path.toLowerCase().includes(search)) ||
          (doc.new_path && doc.new_path.toLowerCase().includes(search)) ||
          doc.summary.toLowerCase().includes(search) ||
          doc.registre.toLowerCase().includes(search) ||
          (doc.subcategory && doc.subcategory.toLowerCase().includes(search)) ||
          (doc.contact_name && doc.contact_name.toLowerCase().includes(search)) ||
          (doc.contact_email && doc.contact_email.toLowerCase().includes(search)) ||
          doc.tags.toLowerCase().includes(search) ||
          doc.raw_text.toLowerCase().includes(search);

        return matchesCategory && matchesSubcategory && matchesQuery;
      });

      const formatted = filtered.map(doc => ({
        id: doc.id,
        checksum: doc.checksum,
        title: doc.title,
        registre: doc.registre,
        date: doc.date,
        category: doc.category,
        subcategory: doc.subcategory || 'general',
        summary: doc.summary,
        tags: safeParseJSON(doc.tags, []),
        raw_text: (doc.raw_text || '').substring(0, 800),
        markdown_content: doc.markdown_content || '',
        total_amount: doc.total_amount || '',
        vat_amount: doc.vat_amount || '',
        siren: doc.siren || '',
        iban: doc.iban || '',
        expiry_date: doc.expiry_date || '',
        contact_name: doc.contact_name || '',
        contact_email: doc.contact_email || '',
        contact_phone: doc.contact_phone || '',
        contact_address: doc.contact_address || '',
        contact_website: doc.contact_website || '',
        original_filename: doc.original_filename,
        original_path: doc.original_path,
        new_path: doc.new_path,
        status: doc.status,
        created_at: doc.created_at,
        updated_at: doc.updated_at
      }));

      res.json({ total: formatted.length, documents: formatted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Export documents to CSV spreadsheet
  app.get('/api/documents/export/csv', async (req, res) => {
    try {
      const docs = await getAllDocuments();
      const search = (req.query.q as string || '').toLowerCase();
      const category = (req.query.category as string || '').toLowerCase();
      const subcategory = (req.query.subcategory as string || '').toLowerCase();

      const filtered = docs.filter(doc => {
        const matchesCategory = !category || doc.category.toLowerCase() === category;
        const matchesSubcategory = !subcategory || (doc.subcategory && doc.subcategory.toLowerCase() === subcategory);
        const matchesQuery = !search ||
          doc.title.toLowerCase().includes(search) ||
          (doc.original_filename && doc.original_filename.toLowerCase().includes(search)) ||
          doc.summary.toLowerCase().includes(search) ||
          doc.registre.toLowerCase().includes(search) ||
          (doc.subcategory && doc.subcategory.toLowerCase().includes(search)) ||
          (doc.contact_name && doc.contact_name.toLowerCase().includes(search)) ||
          (doc.contact_email && doc.contact_email.toLowerCase().includes(search)) ||
          doc.tags.toLowerCase().includes(search);

        return matchesCategory && matchesSubcategory && matchesQuery;
      });

      const csvRows = [
        ['ID', 'Checksum', 'Title', 'Category', 'Subcategory', 'Date', 'Expiry Date', 'Total Amount', 'VAT Amount', 'SIREN', 'IBAN', 'Contact Name', 'Contact Email', 'Contact Phone', 'Contact Address', 'Contact Website', 'Reference', 'Status', 'Summary', 'Original Filename', 'New Path']
      ];

      for (const d of filtered) {
        csvRows.push([
          String(d.id),
          d.checksum || '',
          d.title || '',
          d.category || '',
          d.subcategory || '',
          d.date || '',
          d.expiry_date || '',
          d.total_amount || '',
          d.vat_amount || '',
          d.siren || '',
          d.iban || '',
          d.contact_name || '',
          d.contact_email || '',
          d.contact_phone || '',
          d.contact_address || '',
          d.contact_website || '',
          d.registre || '',
          d.status || '',
          (d.summary || '').replace(/\r?\n/g, ' '),
          d.original_filename || '',
          d.new_path || d.original_path || ''
        ]);
      }

      const escapeCsvCell = (val: string) => `"${val.replace(/"/g, '""')}"`;
      const csvContent = '\uFEFF' + csvRows.map(row => row.map(escapeCsvCell).join(',')).join('\r\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="smart_pdf_triage_export_${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csvContent);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Imports photographs into the incoming folder so the normal pipeline converts and files them.
   *
   * One image per request, sent as a raw body rather than JSON or multipart:
   *   - JSON would mean base64, inflating every photo by a third, and the global express.json()
   *     limit (100 kB) rejects a phone photo long before the route is reached. A route-level
   *     parser cannot help, because the global one runs first.
   *   - multipart would mean adding multer for a single endpoint.
   * express.raw() with its own content type sidesteps both: the global JSON parser ignores it.
   *
   * The file is written, not converted here. Dropping it in the incoming folder is exactly what
   * happens when the user copies a photo in by hand, so it goes through the same conversion,
   * classification and filing path with no second implementation to keep in sync.
   */
  app.post('/api/images/import',
    express.raw({ type: 'application/octet-stream', limit: '64mb' }),
    (req, res) => {
      try {
        const raw = (req.query.filename as string) || '';
        // basename() then a strict slug: the name comes from the browser and lands in a
        // path.join(). Anything outside [A-Za-z0-9._-] is collapsed rather than trusted.
        const safeName = path.basename(raw).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '');
        const ext = path.extname(safeName).toLowerCase();

        if (!IMPORTABLE_IMAGE_EXTENSIONS.has(ext)) {
          return res.status(400).json({
            error: `Unsupported image type '${ext || '(none)'}'. Accepted: ${[...IMPORTABLE_IMAGE_EXTENSIONS].join(', ')}`,
          });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'Empty image body.' });
        }

        ensureDirectoriesExist();

        const base = path.basename(safeName, ext) || 'image';
        let target = path.join(CONFIG.INPUT_DIR, `${base}${ext}`);
        for (let attempt = 1; ; attempt++) {
          try {
            // 'wx' so an import can never overwrite a file already waiting in the incoming folder.
            fs.writeFileSync(target, req.body, { flag: 'wx' });
            break;
          } catch (err: any) {
            if (err?.code !== 'EEXIST') throw err;
            if (attempt > 50) {
              return res.status(409).json({ error: 'Could not find a free filename in the incoming folder.' });
            }
            target = path.join(CONFIG.INPUT_DIR, `${base}_${attempt}${ext}`);
          }
        }

        logger.info('IMPORT', `Imported image into the incoming folder`, { target, bytes: req.body.length });
        res.json({ message: 'Image imported', path: target, filename: path.basename(target) });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

  // Merge multiple PDF files into one PDF
  app.post('/api/pdf/merge', async (req, res) => {
    try {
      const { filepaths, outputFilename } = req.body || {};
      if (!Array.isArray(filepaths) || filepaths.length < 2) {
        return res.status(400).json({ error: 'At least 2 PDF filepaths are required for merging.' });
      }

      const mergedPdf = await PDFDocument.create();

      for (const fp of filepaths) {
        const absFp = resolveManagedPath(fp);
        if (!absFp) {
          return res.status(403).json({ error: 'Path is outside the managed input/output directories — not allowed.' });
        }
        if (!fs.existsSync(absFp)) {
          return res.status(404).json({ error: `PDF file not found on disk: ${fp}` });
        }
        const pdfBytes = fs.readFileSync(absFp);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
      }

      const mergedBytes = await mergedPdf.save();
      const name = outputFilename ? outputFilename.replace(/[^a-zA-Z0-9_.-]/g, '_') : `merged_${Date.now()}.pdf`;
      const targetPath = path.join(CONFIG.INPUT_DIR, name.endsWith('.pdf') ? name : `${name}.pdf`);

      fs.writeFileSync(targetPath, mergedBytes);
      logger.info('PDF_UTIL', `Merged ${filepaths.length} PDFs into '${targetPath}'`);

      res.json({
        message: `Successfully merged ${filepaths.length} PDF files into ${path.basename(targetPath)}`,
        targetPath
      });
    } catch (err: any) {
      res.status(500).json({ error: 'PDF merge failed: ' + err.message });
    }
  });

  // Local AI Chat Assistant Endpoint (Q&A & Dossier Preparation)
  app.post('/api/chat', async (req, res) => {
    try {
      const { message, history } = req.body || {};
      if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Message text is required.' });
      }

      const result = await processChatQuery(message, history || []);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // MCP Engine Status & Tools List Endpoint
  app.get('/api/mcp/status', async (_req, res) => {
    try {
      const { listMcpTools } = await import('../mcp/mcp-server.js');
      const mcpInfo = await listMcpTools();
      res.json({
        status: 'active',
        connected: true,
        toolsCount: mcpInfo.tools.length,
        tools: mcpInfo.tools.map(t => ({ name: t.name, description: t.description }))
      });
    } catch (err: any) {
      res.status(500).json({ status: 'error', connected: false, error: err.message });
    }
  });

  // Download selected documents packaged into a single ZIP archive
  app.post('/api/documents/package-zip', async (req, res) => {
    try {
      const { docIds, zipName } = req.body || {};
      if (!Array.isArray(docIds) || docIds.length === 0) {
        return res.status(400).json({ error: 'docIds array is required and cannot be empty.' });
      }

      const { createZipArchive } = await import('../zip-builder.js');
      const zipFiles: Array<{ name: string; path: string }> = [];

      for (const id of docIds) {
        const docId = parseInt(id, 10);
        if (isNaN(docId)) continue;
        const doc = await getDocumentById(docId);
        if (doc) {
          const fileOnDisk = findActualFileOnDisk(doc);
          if (fileOnDisk && fs.existsSync(fileOnDisk)) {
            const ext = path.extname(fileOnDisk) || '.pdf';
            const baseTitle = (doc.title || doc.original_filename || `doc_${doc.id}`).replace(/[/\\?%*:|"<>]/g, '_');
            const fileNameInZip = baseTitle.endsWith(ext) ? baseTitle : `${baseTitle}${ext}`;
            zipFiles.push({ name: fileNameInZip, path: fileOnDisk });
          }
        }
      }

      if (zipFiles.length === 0) {
        return res.status(404).json({ error: 'None of the requested document files exist on disk.' });
      }

      const zipBuffer = createZipArchive(zipFiles);
      const downloadName = (zipName || 'dossier_documents_package.zip').replace(/[^a-zA-Z0-9_.-]/g, '_');

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.send(zipBuffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Open document location in OS File Explorer (Windows Explorer)
  app.post('/api/documents/:id/open-folder', async (req, res) => {
    try {
      const docId = parseInt(req.params.id, 10);
      const doc = await getDocumentById(docId);
      if (!doc) {
        return res.status(404).json({ error: 'Document not found' });
      }
      const fileOnDisk = findActualFileOnDisk(doc);
      if (!fileOnDisk || !fs.existsSync(fileOnDisk)) {
        return res.status(404).json({ error: 'Document file not found on disk' });
      }

      // Launcher logic (platform branching + WSL->Windows conversion) lives in os-open.ts; under
      // WSL it reveals the file in Windows Explorer via interop, the Linux file opener otherwise.
      // spawn() with an argument array, never exec() with an interpolated string — fileOnDisk
      // traces back to AI-classified document metadata (title/entity extracted from a PDF's
      // own text), which is not guaranteed free of shell metacharacters even after this app's
      // own filename sanitization (e.g. & and % both survive it).
      const launch = revealInFileManager(fileOnDisk);
      if (launch) spawn(launch.cmd, launch.args, { detached: true, stdio: 'ignore' }).unref();

      res.json({ message: 'Opened folder in OS file manager', filePath: fileOnDisk });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Split a multi-page PDF into single page files
  app.post('/api/pdf/split', async (req, res) => {
    try {
      const { filepath } = req.body || {};
      const absFilepath = resolveManagedPath(filepath);
      if (filepath && !absFilepath) {
        return res.status(403).json({ error: 'Path is outside the managed input/output directories — not allowed.' });
      }
      if (!absFilepath || !fs.existsSync(absFilepath)) {
        return res.status(400).json({ error: 'Valid PDF filepath is required.' });
      }

      const pdfBytes = fs.readFileSync(absFilepath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pageCount = pdfDoc.getPageCount();

      if (pageCount <= 1) {
        return res.status(400).json({ error: 'PDF only has 1 page; splitting requires a multi-page PDF.' });
      }

      const stem = path.basename(absFilepath, path.extname(filepath));
      const createdFiles: string[] = [];

      for (let i = 0; i < pageCount; i++) {
        const newPdf = await PDFDocument.create();
        const [copiedPage] = await newPdf.copyPages(pdfDoc, [i]);
        newPdf.addPage(copiedPage);
        const singleBytes = await newPdf.save();
        const singleName = `${stem}_page_${i + 1}.pdf`;
        const singlePath = path.join(CONFIG.INPUT_DIR, singleName);
        fs.writeFileSync(singlePath, singleBytes);
        createdFiles.push(singleName);
      }

      logger.info('PDF_UTIL', `Split '${filepath}' (${pageCount} pages) into ${createdFiles.length} files in __raws`);

      res.json({
        message: `Successfully split PDF into ${createdFiles.length} single-page PDF files in __raws`,
        createdFiles
      });
    } catch (err: any) {
      res.status(500).json({ error: 'PDF split failed: ' + err.message });
    }
  });

  /**
   * Serves the photograph a document was made from, for the manual editor.
   *
   * 404 rather than an error when there is none: documents that arrived as PDFs never had one,
   * and anything converted before source retention existed had its photo deleted outright. The
   * UI uses that to decide whether to offer "Re-edit" at all.
   */
  app.get('/api/documents/:id/source-image', async (req, res) => {
    try {
      const doc = await getDocumentById(parseInt(req.params.id, 10));
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      if (!doc.source_image_path) {
        return res.status(404).json({ error: 'This document has no retained source image.' });
      }

      // Same boundary rule as every other path taken from stored state — the column is written by
      // the pipeline, but it is still a path being handed to fs.
      const absPath = resolveManagedPath(doc.source_image_path);
      if (!absPath) {
        return res.status(403).json({ error: 'Source image is outside the managed directories.' });
      }
      if (!fs.existsSync(absPath)) {
        return res.status(404).json({ error: 'Source image is no longer on disk.' });
      }

      const ext = path.extname(absPath).toLowerCase();
      const mime = ext === '.png' ? 'image/png'
        : ext === '.webp' ? 'image/webp'
        : ext === '.bmp' ? 'image/bmp'
        : (ext === '.tiff' || ext === '.tif') ? 'image/tiff'
        : 'image/jpeg';
      res.setHeader('Content-Type', mime);
      res.sendFile(absPath);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve PDF file by path inline to browser
  app.get('/api/documents/file-by-path', (req, res) => {
    try {
      const targetPath = req.query.path as string;
      if (!targetPath) {
        return res.status(404).json({ error: 'PDF file missing on disk' });
      }

      // Security: this endpoint previously served ANY file the Node process could read (e.g.
      // package.json, or worse — SSH keys, other apps' .env files) with only an existsSync
      // check and no boundary validation. Every legitimate file this endpoint is meant to serve
      // lives inside INPUT_DIR or OUTPUT_ROOT_DIR — reject anything else before even touching fs.
      const absPath = resolveManagedPath(targetPath);
      if (!absPath) {
        return res.status(403).json({ error: 'Path is outside the managed input/output directories — not allowed.' });
      }

      if (!fs.existsSync(absPath)) {
        return res.status(404).json({ error: 'PDF file missing on disk' });
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline');
      res.sendFile(absPath);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get single document with full raw text
  app.get('/api/documents/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const doc = await getDocumentById(id);
      if (!doc) {
        return res.status(404).json({ error: 'Document not found' });
      }

      res.json({
        ...doc,
        tags: safeParseJSON(doc.tags, [])
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve raw PDF file inline to browser with Content-Disposition: inline (opens in new tab)
  app.get('/api/documents/:id/file', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const doc = await getDocumentById(id);
      if (!doc) {
        return res.status(404).json({ error: 'Document not found' });
      }

      const targetPath = doc.new_path || doc.original_path;
      if (!targetPath || !fs.existsSync(targetPath)) {
        return res.status(404).json({ error: 'PDF file missing on disk' });
      }

      const absPath = path.resolve(targetPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline');
      res.sendFile(absPath);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bulk-export every document's converted Markdown as individual .md files in one ZIP —
  // registered BEFORE /api/documents/:id/markdown (same reason /api/documents/export/csv is
  // registered before /api/documents/:id): Express matches routes in registration order, and
  // :id/markdown would otherwise swallow this request by treating "export" as the :id value.
  app.get('/api/documents/export/markdown', async (req, res) => {
    try {
      const docs = await getAllDocuments();
      const usedNames = new Set<string>();

      const zipFiles = docs.map(doc => {
        const content = doc.markdown_content || doc.raw_text || '';
        let baseTitle = (doc.title || doc.original_filename || `document_${doc.id}`).replace(/[/\\?%*:|"<>]/g, '_');
        let fileName = `${baseTitle}.md`;
        // Multiple documents can share the same title (e.g. two "Accusé de réception" scans) —
        // dedupe by suffixing the doc id rather than silently overwriting one entry in the zip.
        if (usedNames.has(fileName)) {
          fileName = `${baseTitle}_${doc.id}.md`;
        }
        usedNames.add(fileName);
        return { name: fileName, content: Buffer.from(content, 'utf-8') };
      });

      const { createZipArchive } = await import('../zip-builder.js');
      const zipBuffer = createZipArchive(zipFiles);
      const downloadName = `smart_pdf_triage_markdown_export_${new Date().toISOString().slice(0, 10)}.zip`;

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.send(zipBuffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download a single document's converted Markdown as a .md file
  app.get('/api/documents/:id/markdown', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const doc = await getDocumentById(id);
      if (!doc) {
        return res.status(404).json({ error: 'Document not found' });
      }

      const content = doc.markdown_content || doc.raw_text || '';
      const baseTitle = (doc.title || doc.original_filename || `document_${doc.id}`).replace(/[/\\?%*:|"<>]/g, '_');

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', contentDispositionAttachment(`${baseTitle}.md`));
      res.send(content);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete document: unregister from DB & move file to __raws/.delete_files
  app.delete('/api/documents/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const result = await deleteDocumentAndMoveToTrash(id);
      if (!result.success) {
        return res.status(404).json({ error: result.error });
      }
      broadcastTriageEvent({ type: 'DOCUMENTS_UPDATED' });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update document metadata & relocalize file if category/subcategory changed
  app.put('/api/documents/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const docBefore = await getDocumentById(id);
      const validatedUpdates = UpdateDocumentSchema.parse(req.body);

      // Golden Rule #4: reject an explicit attempt to set a forbidden subcategory
      // (general/other/divers/year) before writing anything — but don't re-block an
      // unrelated edit (e.g. just the title) on a document whose EXISTING subcategory
      // happens to already be one of these from before this rule was enforced everywhere.
      const explicitSubcategory = validatedUpdates.subcategory ?? validatedUpdates.subcategorie;
      if (explicitSubcategory !== undefined && isForbiddenSubcategory(explicitSubcategory)) {
        return res.status(400).json({ error: `'${explicitSubcategory}' is not a valid subcategory (general/other/divers/year strings are not allowed — Golden Rule #4). Please choose a specific entity or document-type name.` });
      }

      const success = await updateDocumentRecord(id, validatedUpdates);
      if (!success || !docBefore) {
        return res.status(404).json({ error: 'Document not found or update failed' });
      }

      // Automatically relocalize file on disk if category or subcategory changed
      if (docBefore.new_path && fs.existsSync(docBefore.new_path)) {
        const targetCategory = validatedUpdates.category || validatedUpdates.categorie || docBefore.category;
        const targetSubcategory = validatedUpdates.subcategory || validatedUpdates.subcategorie || docBefore.subcategory;
        // Golden Rule #5: the category/subcategory must exist in categories.json BEFORE
        // the physical move — this route previously skipped that step entirely.
        ensureCategoryAndSubcategoryExist(targetCategory, targetSubcategory);
        const { newPath } = relocalizeFileIfNeeded(
          docBefore.new_path,
          targetCategory,
          targetSubcategory,
          validatedUpdates.date || docBefore.date
        );
        if (newPath !== docBefore.new_path) {
          await updateDocumentRecord(id, { new_path: newPath });
        }
      }

      await syncJSONRegistry();
      broadcastTriageEvent({ type: 'REGISTRY_UPDATED', action: 'EDIT', docId: id });
      const updatedDoc = await getDocumentById(id);
      res.json({
        message: 'Document updated successfully and relocalized if needed',
        document: {
          ...updatedDoc,
          tags: safeParseJSON(updatedDoc?.tags || '[]', [])
        }
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Relocalize & Re-analyze a single document by ID with optional explicit category, subcategory, or AI feedback note
  app.post('/api/documents/:id/relocalize', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { category, subcategory, reason } = req.body || {};
      const result = await reclassifyAndRelocalizeDocument(id, category, subcategory, reason);
      if (!result.success) {
        return res.status(result.staleCleaned ? 404 : 400).json(result);
      }
      broadcastTriageEvent({ type: 'REGISTRY_UPDATED', action: 'RELOCALIZE', docId: id });
      broadcastTriageEvent({ type: 'CATEGORIES_UPDATED' });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Clear registry & move all files from __archive back to __raws
  app.delete('/api/documents', async (req, res) => {
    if (isAutoScanning) {
      res.status(409).json({ error: 'A scan/repair/clear operation is already in progress. Try again shortly.' });
      return;
    }
    isAutoScanning = true;
    startTask('CLEAR', 0, 'Initializing registry clear...');
    try {
      const { countMoved } = await clearRegistryAndMoveArchiveToRaws((evt) => {
        if (evt.type === 'CLEAR_STARTED') {
          updateTaskProgress(0, '', 'CLEARING', evt.message, evt.totalFiles);
        } else if (evt.type === 'FILE_PROGRESS' || evt.type === 'FILE_COMPLETED') {
          updateTaskProgress(evt.scannedCount || evt.processedCount || 0, evt.filename, evt.stage, evt.message, evt.totalFiles);
        }
        broadcastTriageEvent(evt);
      });
      finishTask({ countMoved }, `Registry cleared. Moved ${countMoved} PDF file(s) back to __raws.`);
      broadcastTriageEvent({ type: 'REGISTRY_UPDATED', action: 'CLEAR' });
      broadcastTriageEvent({ type: 'CATEGORIES_UPDATED' });
      res.json({
        message: `Registry cleared successfully. Moved ${countMoved} PDF file(s) from __archive back to __raws.`,
        countMoved
      });
    } catch (err: any) {
      failTask(err.message);
      res.status(500).json({ error: err.message });
    } finally {
      isAutoScanning = false;
    }
  });

  // SSE Triage Scan Live Progress Stream
  const triageSseClients: express.Response[] = [];
  app.get('/api/triage/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    triageSseClients.push(res);

    const cleanup = () => {
      const idx = triageSseClients.indexOf(res);
      if (idx !== -1) triageSseClients.splice(idx, 1);
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  // Set by POST /api/triage/unlock, cleared when a new scan starts. Polled per file by
  // runTriageScan so "Stop" actually stops rather than just dropping the re-entry guard.
  let scanAbortRequested = false;

  function broadcastTriageEvent(event: any) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    triageSseClients.forEach(client => {
      try {
        client.write(payload);
      } catch (e) {}
    });
  }

  // Forcefully clear active operation locks (manual stop by user)
  app.post('/api/triage/unlock', (req, res) => {
    // Ask the running loop to stop at its next file boundary. Clearing isAutoScanning alone never
    // stopped anything — it only re-opened the door for a second concurrent scan.
    scanAbortRequested = true;
    isAutoScanning = false;
    // Suppress auto-watcher for 60 seconds so it doesn't immediately re-trigger
    manualStopCooldownUntil = Date.now() + 60_000;
    resetTaskState();
    broadcastTriageEvent({ type: 'REGISTRY_UPDATED', action: 'UNLOCK' });
    res.json({ message: 'Operation lock forcefully cleared. Auto-watcher paused for 60s.' });
  });

  // 10-Second Auto-Scan Watcher: Check __raws every 10s and put PDF into category pills automatically
  setInterval(async () => {
    if (isAutoScanning) return;
    // Respect manual-stop cooldown: skip watcher tick until cooldown expires
    if (Date.now() < manualStopCooldownUntil) return;
    // Claim the guard synchronously, before any `await` — the per-file blocked-check loop
    // below is async (getBlockedFile is a DB call per incoming file, up to hundreds of them),
    // and setInterval fires again every 10s regardless of whether this tick's callback has
    // finished. Setting isAutoScanning only after that loop left a race window where a manual
    // scan (or the next tick) could pass the `if (isAutoScanning) return` guard above and start
    // a second concurrent runTriageScan() against the same __raws/__archive files — this is
    // what produced "SQLITE_CONSTRAINT: UNIQUE constraint failed: documents.checksum" for
    // documents that had already been fully classified by the other concurrent run.
    isAutoScanning = true;
    try {
      const incoming = getPDFsRecursively(CONFIG.INPUT_DIR, CONFIG.OUTPUT_ROOT_DIR);
      if (incoming.length > 0) {
        const unblocked: string[] = [];
        for (const p of incoming) {
          try {
            const fileStat = fs.statSync(p);
            const blocked = await getBlockedFile(p);
            if (!blocked || blocked.mtime_ms !== fileStat.mtimeMs || blocked.size !== fileStat.size) {
              unblocked.push(p);
            }
          } catch {
            unblocked.push(p);
          }
        }

        if (unblocked.length > 0) {
          logger.info('AUTO_WATCHER', `Auto-scan triggered: Found ${unblocked.length} incoming PDF(s) in __raws`);
          scanAbortRequested = false;
          startTask('SCAN', unblocked.length, `Auto-scanning ${unblocked.length} incoming PDF(s) in __raws...`);
          try {
            const result = await runTriageScan((evt) => {
              if (evt.type === 'SCAN_STARTED') {
                updateTaskProgress(0, '', 'SCANNING', evt.message, evt.totalFiles);
              } else if (evt.type === 'FILE_PROGRESS' || evt.type === 'FILE_COMPLETED' || evt.type === 'FILE_FAILED') {
                updateTaskProgress(evt.scannedCount || evt.processedCount || 0, evt.filename, evt.stage, evt.message, evt.totalFiles);
              }
              broadcastTriageEvent(evt);
            }, () => scanAbortRequested);
            finishTask(result, `Auto-scan completed. Processed ${result.processedCount || 0} file(s).`);
          } catch (scanErr: any) {
            failTask(scanErr.message);
          }
        }
      }
    } catch (err: any) {
      logger.error('AUTO_WATCHER', `Error in 10s auto-scan watcher: ${err.message}`);
    } finally {
      isAutoScanning = false;
    }
  }, 10000);

  // Trigger triage scan with live progress broadcasting
  app.post('/api/triage/scan', async (req, res) => {
    if (isAutoScanning) {
      res.status(409).json({ error: 'A scan/repair/clear operation is already in progress. Try again shortly.' });
      return;
    }
    isAutoScanning = true;
    scanAbortRequested = false;
    startTask('SCAN', 0, 'Initializing triage scan...');
    try {
      const result = await runTriageScan((evt) => {
        if (evt.type === 'SCAN_STARTED') {
          updateTaskProgress(0, '', 'SCANNING', evt.message, evt.totalFiles);
        } else if (evt.type === 'FILE_PROGRESS' || evt.type === 'FILE_COMPLETED' || evt.type === 'FILE_FAILED') {
          updateTaskProgress(evt.scannedCount || evt.processedCount || 0, evt.filename, evt.stage, evt.message, evt.totalFiles);
        }
        broadcastTriageEvent(evt);
      }, () => scanAbortRequested);
      finishTask(result, `Triage scan completed. Processed ${result.processedCount || 0} file(s).`);
      res.json({ message: 'Triage scan completed', ...result });
    } catch (err: any) {
      failTask(err.message);
      res.status(500).json({ error: err.message });
    } finally {
      isAutoScanning = false;
    }
  });

  return app;
}

function safeParseJSON(str: string, fallback: any) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// HTTP headers must be ASCII — putting a raw accented filename (e.g. a French document title
// like "Avis de Taxes Foncières") straight into Content-Disposition mojibakes it for clients
// that don't re-decode it as UTF-8 (confirmed via curl: "FONCI�RES"). RFC 6266 fixes this with
// a dual filename: an ASCII-safe fallback for old clients, plus filename*=UTF-8''<percent-
// encoded> that browsers use to display the real accented name.
function contentDispositionAttachment(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// DATA_DIR, not BASE_DIR: the lock is writable per-install state, and BASE_DIR for a packaged app
// is resources/app — a folder an upgrade replaces wholesale and which a real install (Program
// Files) may not even be writable. It also makes the lock mean what it should: one server per data
// directory, rather than one per copy of the application files.
const PID_LOCK_FILE = path.join(DATA_DIR, '.server.lock');

// Prevent two instances of this server (e.g. a stale tsx-watch child that hasn't
// exited yet plus a freshly-spawned one) from running their auto-watchers
// concurrently against the same __raws/__archive files.
function acquireSingleInstanceLock(): void {
  const holderPid = readActiveLockHolder(PID_LOCK_FILE);
  if (holderPid !== null) {
    console.error(`Another instance of this server is already running (PID ${holderPid}). Refusing to start a second instance — stop it first, or delete ${PID_LOCK_FILE} if it's stale.`);
    process.exit(1);
  }

  const releaseLock = acquireProcessLock(PID_LOCK_FILE);
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
}

export async function startWebServer(port: number = CONFIG.PORT): Promise<void> {
  acquireSingleInstanceLock();

  // Same contract as the HTTP port takeover below, applied to the PaddleOCR sidecar: a restart must
  // mean current code. The service is a separate Python process that outlives this one and answers
  // /health even when it is running stale code, so without this an edit under paddleocr-server/
  // never loads until the user hunts down the PID themselves.
  //
  // Awaited rather than fire-and-forget: the 10s auto-watcher can start a scan shortly after boot,
  // and a kill landing after that would take out a server the first OCR call had just spawned.
  const restarted = await takeOverPaddleOcrServer();
  if (restarted) {
    console.log('Restarted the PaddleOCR service so it picks up the current paddleocr-server/ code.');
  }

  attemptListen(port, true);
}

// Splits out from startWebServer so the EADDRINUSE handler can retry with a fresh app/server
// after killing whatever held the port. allowTakeover is false on the retry so a port that's
// still unavailable after the kill attempt (e.g. held by something taskkill couldn't remove)
// fails fast instead of looping forever.
function attemptListen(port: number, allowTakeover: boolean): void {
  const app = createWebServer();
  const server = app.listen(port, CONFIG.HOST, () => {
    console.log(`Web Dashboard is running at http://${CONFIG.HOST}:${port} [Hot Reload Active 🔥]`);
  });
  server.on('error', async (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') {
      console.error('Web server failed to start:', err.message);
      process.exit(1);
      return;
    }
    if (!allowTakeover) {
      console.error(`Port ${port} is still in use after a takeover attempt — exiting.`);
      process.exit(1);
      return;
    }
    console.warn(`Port ${port} is already in use — attempting to take over from the previous instance...`);
    const killed = await killProcessOnPort(port);
    if (!killed) {
      console.error(`Port ${port} is in use, but no process could be found to free it.`);
      process.exit(1);
      return;
    }
    console.warn(`Killed the process holding port ${port}. Retrying...`);
    setTimeout(() => attemptListen(port, false), 500);
  });
}
