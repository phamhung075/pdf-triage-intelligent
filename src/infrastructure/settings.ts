import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// Derived from this file's own location, NOT process.cwd(). cwd works fine for npm scripts
// (tsx src/index.ts always runs with cwd = project root) but is unreliable for the packaged
// Electron .exe: desktop/main.cjs imports the compiled dist/index.js in-process via a dynamic
// import() rather than spawning it as a child process with an explicit cwd, so it inherits
// Electron's own process.cwd() — which for a launched/double-clicked app is not guaranteed to
// be the install directory at all. This file's location is stable in both cases:
// src/infrastructure/settings.ts (tsx, dev) and dist/infrastructure/settings.js (compiled,
// packaged) are both exactly two directories below the project root.
// PDF_TRIAGE_BASE_DIR overrides this for setups that need something else entirely.
const THIS_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BASE_DIR = process.env.PDF_TRIAGE_BASE_DIR
  ? path.resolve(process.env.PDF_TRIAGE_BASE_DIR)
  : path.resolve(THIS_FILE_DIR, '..', '..');

// dotenv.config() with no explicit `path` defaults to looking for .env in process.cwd() —
// exactly the same unreliable-in-packaged-Electron problem BASE_DIR just had. Point it at
// BASE_DIR explicitly instead of trusting cwd.
/**
 * Where WRITABLE state lives, as opposed to BASE_DIR which holds read-only app assets.
 *
 * These were the same directory, which is fine for a git checkout and wrong for an installed app:
 * the packaged layout puts the app under dist-installer/win-unpacked/resources/app, and
 * `npm run dist:exe` begins by deleting dist-installer outright — so the database, the registry,
 * settings.json and both private overlays were destroyed by every rebuild, and would be destroyed
 * by every upgrade. (That is not hypothetical: it happened, and took a test document with it.)
 *
 * The desktop shell sets PDF_TRIAGE_DATA_DIR to Electron's userData path when packaged
 * (see desktop/main.cjs). Unset — a git checkout, `npm run dev`, `npm run scan`, the MCP server,
 * the test suite — it falls back to BASE_DIR, so nothing changes for development.
 *
 * The split, concretely:
 *   BASE_DIR (read-only, replaced on upgrade) : prompts/, categories.json, entity_dictionary.json
 *   DATA_DIR (writable, survives upgrades)    : settings.json, the DB, registry.json, the private
 *                                               overlays, manual_decisions.json, default folders
 */
export const DATA_DIR = process.env.PDF_TRIAGE_DATA_DIR
  ? path.resolve(process.env.PDF_TRIAGE_DATA_DIR)
  : BASE_DIR;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// .env is read from DATA_DIR first (an installed app's own config) and falls back to BASE_DIR so a
// checkout keeps working unchanged.
const DATA_ENV = path.join(DATA_DIR, '.env');
dotenv.config({ path: fs.existsSync(DATA_ENV) ? DATA_ENV : path.join(BASE_DIR, '.env') });
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// WSL/Windows path conversion lives in the pure domain module src/domain/path-conversion.ts
// (windowsToWslPath / wslToWindowsPath / isWslMountPath). It is re-exported here under the
// historical names so existing importers and tests keep working unchanged. Rule: paths the app's
// fs reads/writes on WSL are /mnt/... form; paths handed to Windows programs (explorer/chrome) are
// X:\... form — every OS launch goes through src/infrastructure/os-open.ts.
import {
  windowsToWslPath as normalizePathInput,
  wslToWindowsPath as toWindowsPath,
  isWslMountPath,
} from '../domain/path-conversion.js';
export { normalizePathInput, toWindowsPath, isWslMountPath };


/**
 * True when this install has never been configured — no settings.json, or one without the two
 * folder paths the pipeline cannot run without. Drives the first-run setup screen.
 *
 * Deliberately a function, not a captured constant: the wizard writes settings.json and then asks
 * again, and a stale snapshot would keep reporting "unconfigured" until restart.
 */
export function isFirstRun(): boolean {
  const current = loadCustomSettings();
  return !current.input_dir || !current.output_root_dir;
}

export function loadCustomSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return JSON.parse(raw);
    } catch (e) {
      console.error("Error reading settings.json", e);
    }
  }
  return {};
}

const customSettings = loadCustomSettings();

// Golden Rule #14: only qwen3.5:9b is supported. Legacy/cloud/subscription-gated models
// are rejected even if they somehow end up in settings.json (manual edit, stale API
// caller, etc.) rather than silently trusted — this is what let 'kimi-k3:cloud' run
// undetected for hours.
const ALLOWED_OLLAMA_MODEL = 'qwen3.5:9b';
function sanitizeOllamaModel(model: unknown): string {
  if (model === ALLOWED_OLLAMA_MODEL) return ALLOWED_OLLAMA_MODEL;
  if (model) {
    console.warn(`Ignoring unsupported ollama_model '${model}' (only '${ALLOWED_OLLAMA_MODEL}' is allowed per Golden Rule #14) — falling back to '${ALLOWED_OLLAMA_MODEL}'.`);
  }
  return ALLOWED_OLLAMA_MODEL;
}

// Same lock-down pattern as ALLOWED_OLLAMA_MODEL above, but for the separate vision model
// used by the Vision Lab image-to-PDF pipeline (orientation/crop detection) — a distinct
// concern from text classification, so it gets its own pinned value rather than overloading
// OLLAMA_MODEL / Golden Rule #14.
const ALLOWED_OLLAMA_VISION_MODEL = 'minicpm-v4.6:latest';
function sanitizeOllamaVisionModel(model: unknown): string {
  if (model === ALLOWED_OLLAMA_VISION_MODEL) return ALLOWED_OLLAMA_VISION_MODEL;
  if (model) {
    console.warn(`Ignoring unsupported OLLAMA_VISION_MODEL env value '${model}' (only '${ALLOWED_OLLAMA_VISION_MODEL}' is supported by the Vision Lab pipeline) — falling back to '${ALLOWED_OLLAMA_VISION_MODEL}'.`);
  }
  return ALLOWED_OLLAMA_VISION_MODEL;
}

// Default set of owner/household name tokens (lowercase) that must never be accepted as
// a subcategory — see PERSONAL_NAME_DENYLIST usage in domain/classification.ts. Fully configurable via settings.json.
const DEFAULT_PERSONAL_NAME_DENYLIST: string[] = [];
function sanitizePersonalNameDenylist(list: unknown): string[] {
  if (!Array.isArray(list)) return DEFAULT_PERSONAL_NAME_DENYLIST;
  return list.map(v => String(v).toLowerCase().trim()).filter(Boolean);
}

function sanitizeLanguage(lang: unknown): 'FR' | 'EN' {
  if (typeof lang === 'string' && lang.toUpperCase() === 'EN') return 'EN';
  return 'FR';
}

export const CONFIG = {
  LANGUAGE: sanitizeLanguage(customSettings.language || process.env.SYSTEM_LANGUAGE),
  INPUT_DIR: normalizePathInput(customSettings.input_dir) || normalizePathInput(process.env.PDF_INPUT_DIR) || path.join(DATA_DIR, 'input'),
  OUTPUT_ROOT_DIR: normalizePathInput(customSettings.output_root_dir) || normalizePathInput(process.env.PDF_OUTPUT_DIR) || path.join(DATA_DIR, 'organized'),
  JSON_REGISTRY_PATH: process.env.PDF_REGISTRY_PATH || path.join(DATA_DIR, 'registry.json'),
  DB_PATH: process.env.PDF_DB_PATH || path.join(DATA_DIR, 'pdf_triage.db'),
  // Public, generic, committed starter taxonomy (top-level categories only, no personal
  // subcategories). CATEGORIES_PRIVATE_FILE holds everything auto-created from the user's own
  // documents (real bank branches, employers, etc.) — gitignored, never committed. See
  // categories-store.ts for how the two are merged on read and diffed on write.
  CATEGORIES_FILE: path.join(BASE_DIR, 'categories.json'),
  CATEGORIES_PRIVATE_FILE: path.join(DATA_DIR, '.categories.private.json'),
  ENTITY_DICTIONARY_FILE: path.join(BASE_DIR, 'entity_dictionary.json'),
  MANUAL_DECISIONS_FILE: path.join(DATA_DIR, 'manual_decisions.json'),
  // Record of blocked duplicate category/subcategory creations (the HINT half of the taxonomy
  // duplicate guard, see domain/taxonomy-conflicts.ts) — gitignored, re-injected into the model's
  // STEP 0 block so future runs stop proposing the blocked slugs.
  TAXONOMY_HINTS_FILE: path.join(DATA_DIR, 'taxonomy_hints.json'),
  PROMPTS_DIR: path.join(BASE_DIR, 'prompts'),
  // Personal prompt overlay — the private counterpart to the generic, committed prompts/
  // templates. Holds the real employers, bank product codes, scan filename prefixes and
  // clinics that must never be committed, and is rendered into the {{USER_PRIORITY_RULES}}
  // and {{USER_KNOWN_ENTITIES}} placeholders at prompt-build time. Gitignored; see
  // prompts.private.json.example for the shape and prompt-personalization-store.ts for the read.
  PROMPTS_PRIVATE_FILE: path.join(DATA_DIR, '.prompts.private.json'),

  OLLAMA_HOST: customSettings.ollama_host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  OLLAMA_MODEL: sanitizeOllamaModel(customSettings.ollama_model || process.env.OLLAMA_MODEL),
  OLLAMA_EMBED_MODEL: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
  OLLAMA_VISION_MODEL: sanitizeOllamaVisionModel(process.env.OLLAMA_VISION_MODEL),
  VISION_LAB_PORT: parseInt(process.env.VISION_LAB_PORT || '3179', 10),
  PADDLEOCR_HOST: process.env.PADDLEOCR_HOST || 'http://127.0.0.1:8871',
  PADDLEOCR_SPAWN_CMD: process.env.PADDLEOCR_SPAWN_CMD || 'python paddleocr-server/main.py',
  // How many pages of a SCANNED pdf get rendered and OCR'd. This was a hardcoded 3 with no logging,
  // so a 19-page scanned insurance policy silently contributed only its first 3 pages to raw_text,
  // the classifier and the Markdown — 84% of the document simply absent, with nothing in the log to
  // say so. Truncation is now always logged; this knob sets where it happens. Higher costs real
  // time (OCR runs per page, seconds each), so it is a deliberate quality/throughput trade-off
  // rather than something to set to Infinity.
  OCR_MAX_PAGES: (() => {
    const raw = parseInt(process.env.OCR_MAX_PAGES || '10', 10);
    return Number.isFinite(raw) && raw >= 1 ? raw : 10;
  })(),
  // Zoom factor used to render each scanned page before OCR. 2.0 is the long-standing default;
  // raising it (e.g. 2.5-3.0) helps grainy fax/scan pages whose glyphs fall below PaddleOCR's
  // reliable size at 2.0 — split characters ("MIe PALMA BRI G TTE") are the symptom — at the cost
  // of a bigger upload and slower inference per page.
  OCR_RENDER_SCALE: (() => {
    const raw = parseFloat(process.env.OCR_RENDER_SCALE || '2.0');
    return Number.isFinite(raw) && raw >= 1.0 && raw <= 6.0 ? raw : 2.0;
  })(),

  PORT: parseInt(process.env.PORT || '3971', 10),
  // Security default: bind to localhost only. This server has no authentication — binding to
  // 0.0.0.0 (Express's own default when no host is given to app.listen()) would expose the
  // full API, including document contents and destructive actions (clear registry, delete),
  // to anyone on the same network. Only override this if you specifically want LAN access and
  // understand there is no auth layer protecting it.
  HOST: process.env.PDF_TRIAGE_HOST || '127.0.0.1',

  // ---- PDF text-extraction microservice (Docker) -------------------------------------------
  // When PDF_EXTRACT_SERVICE_URL is set (e.g. http://127.0.0.1:3981 when the docker-compose from
  // the repo root is up), extractPDFContent() delegates the whole extraction — PDF text layer,
  // scanned-page OCR, image OCR, DOCX/XLSX/TXT — to that service over HTTP instead of running the
  // heavy parser stack in this process. Unset (the default) keeps today's in-process behavior,
  // so `npm run dev`, the desktop .exe and the test suite are unchanged until the env var is set.
  // The split is graceful by design: an unreachable service falls back to in-process extraction
  // with a WARN so documents never strand just because Docker is down. Set
  // PDF_EXTRACT_SERVICE_REQUIRED=1 to make a dead service a hard error instead of a fallback.
  PDF_EXTRACT_SERVICE_URL: (process.env.PDF_EXTRACT_SERVICE_URL || '').trim(),
  PDF_EXTRACT_SERVICE_REQUIRED: ['1', 'true', 'yes'].includes((process.env.PDF_EXTRACT_SERVICE_REQUIRED || '').trim().toLowerCase()),
  // Per-request timeout for the HTTP extraction call, ms. 0 (the default) = no client timeout:
  // OCR of a scanned page legitimately takes minutes, and the triage pipeline is strictly 1-by-1
  // sequential (Golden Rule #9), so a per-file timeout is a foot-gun, not a safeguard.
  PDF_EXTRACT_SERVICE_TIMEOUT_MS: (() => {
    const raw = parseInt(process.env.PDF_EXTRACT_SERVICE_TIMEOUT_MS || '0', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  })(),
  // Listen settings for the extraction microservice itself (src/extract-service). PDF_EXTRACT_HOST
  // defaults to 127.0.0.1 like HOST above — the Docker image overrides it to 0.0.0.0 so the
  // published container port is reachable from the host.
  EXTRACT_SERVICE_PORT: parseInt(process.env.PDF_EXTRACT_PORT || '3981', 10),
  EXTRACT_SERVICE_HOST: process.env.PDF_EXTRACT_HOST || '127.0.0.1',
  // Upload ceiling for one POST /extract body. PDFs that need page-render OCR can be large; the
  // in-process extractor reads the whole file into RAM anyway (readFileSync), so parity means
  // buffering the upload too.
  EXTRACT_SERVICE_MAX_BYTES: (() => {
    const raw = parseInt(process.env.PDF_EXTRACT_MAX_BYTES || String(512 * 1024 * 1024), 10);
    return Number.isFinite(raw) && raw >= 1024 ? raw : 512 * 1024 * 1024;
  })(),

  // ---- Docling structured-extraction service (optional quality layer) ------------------------
  // Docling (https://github.com/docling-project/docling, layout-aware PDF → Markdown with real
  // tables) can run as a second extractor in front of the existing chain. When
  // DOCLING_SERVICE_URL is set, extractPDFContent() asks Docling first for PDFs; if its output
  // passes the pure quality gate (src/domain/docling-quality.ts), the structured Markdown becomes
  // markdown_content directly (no Step C LLM re-conversion) and its plain text becomes raw_text.
  // If Docling is unreachable, errors, or its output fails the gate, extraction falls back to the
  // normal chain (in-process, or PDF_EXTRACT_SERVICE_URL when that is also set) unchanged — so the
  // default install never notices this layer exists until DOCLING_SERVICE_URL is set.
  DOCLING_SERVICE_URL: (process.env.DOCLING_SERVICE_URL || '').trim(),
  DOCLING_SERVICE_REQUIRED: ['1', 'true', 'yes'].includes((process.env.DOCLING_SERVICE_REQUIRED || '').trim().toLowerCase()),
  DOCLING_SERVICE_TIMEOUT_MS: (() => {
    const raw = parseInt(process.env.DOCLING_SERVICE_TIMEOUT_MS || '0', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  })(),

  // MCP Streamable HTTP transport (npm run mcp) — lets non-stdio agents (OpenAI Agents SDK,
  // other machines on the LAN) call the same tools stdio-based clients (Claude Desktop/Code)
  // use. Unlike HOST above, this one defaults to LAN-reachable (0.0.0.0) by design — mitigated
  // by the required bearer token (see getOrCreateMcpApiToken in mcp-server.ts), not by binding.
  // Every mutating tool call goes through the same handlers as stdio, so the token is the only
  // thing standing between the network and this registry's personal documents.
  MCP_HTTP_PORT: parseInt(process.env.MCP_HTTP_PORT || '3972', 10),
  MCP_HTTP_HOST: process.env.MCP_HTTP_HOST || '0.0.0.0',

  PERSONAL_NAME_DENYLIST: sanitizePersonalNameDenylist(customSettings.personal_name_denylist),
};

export function reloadConfigFromDisk(): void {
  const current = loadCustomSettings();
  CONFIG.LANGUAGE = sanitizeLanguage(current.language);
  if (current.input_dir) CONFIG.INPUT_DIR = normalizePathInput(current.input_dir);
  if (current.output_root_dir) CONFIG.OUTPUT_ROOT_DIR = normalizePathInput(current.output_root_dir);
  CONFIG.OLLAMA_MODEL = sanitizeOllamaModel(current.ollama_model);
  if (current.ollama_host) CONFIG.OLLAMA_HOST = current.ollama_host;
  CONFIG.PERSONAL_NAME_DENYLIST = sanitizePersonalNameDenylist(current.personal_name_denylist);
}

export function updateConfig(newSettings: {
  language?: string;
  input_dir?: string;
  output_root_dir?: string;
  ollama_model?: string;
  ollama_host?: string;
  personal_name_denylist?: string[];
}): void {
  if (newSettings.language) CONFIG.LANGUAGE = sanitizeLanguage(newSettings.language);
  if (newSettings.input_dir) CONFIG.INPUT_DIR = normalizePathInput(newSettings.input_dir);
  if (newSettings.output_root_dir) CONFIG.OUTPUT_ROOT_DIR = normalizePathInput(newSettings.output_root_dir);
  if (newSettings.ollama_model) CONFIG.OLLAMA_MODEL = sanitizeOllamaModel(newSettings.ollama_model);
  if (newSettings.ollama_host) CONFIG.OLLAMA_HOST = newSettings.ollama_host;
  if (newSettings.personal_name_denylist) CONFIG.PERSONAL_NAME_DENYLIST = sanitizePersonalNameDenylist(newSettings.personal_name_denylist);

  const dataToSave = {
    language: CONFIG.LANGUAGE,
    input_dir: CONFIG.INPUT_DIR,
    output_root_dir: CONFIG.OUTPUT_ROOT_DIR,
    ollama_model: CONFIG.OLLAMA_MODEL,
    ollama_host: CONFIG.OLLAMA_HOST,
    personal_name_denylist: CONFIG.PERSONAL_NAME_DENYLIST
  };

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
  ensureDirectoriesExist();
}

export function ensureDirectoriesExist(): void {
  const dirs = [
    CONFIG.INPUT_DIR,
    path.join(CONFIG.INPUT_DIR, '.duplicates_files'),
    path.join(CONFIG.INPUT_DIR, '.blocked_files'),
    path.join(CONFIG.INPUT_DIR, '.delete_files'),
    CONFIG.OUTPUT_ROOT_DIR,
    path.dirname(CONFIG.JSON_REGISTRY_PATH),
    path.dirname(CONFIG.DB_PATH)
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Automatic migration of legacy non-dot folders (blocked_files -> .blocked_files, duplicates_files -> .duplicates_files)
  const legacyBlocked = path.join(CONFIG.INPUT_DIR, 'blocked_files');
  const targetBlocked = path.join(CONFIG.INPUT_DIR, '.blocked_files');
  if (fs.existsSync(legacyBlocked)) {
    try {
      const files = fs.readdirSync(legacyBlocked);
      for (const f of files) {
        const oldP = path.join(legacyBlocked, f);
        const newP = path.join(targetBlocked, f);
        if (fs.existsSync(oldP)) {
          try { fs.renameSync(oldP, newP); } catch { fs.copyFileSync(oldP, newP); try { fs.unlinkSync(oldP); } catch {} }
        }
      }
      try { fs.rmdirSync(legacyBlocked); } catch {}
    } catch (e) {}
  }

  const legacyDups = path.join(CONFIG.INPUT_DIR, 'duplicates_files');
  const targetDups = path.join(CONFIG.INPUT_DIR, '.duplicates_files');
  if (fs.existsSync(legacyDups)) {
    try {
      const files = fs.readdirSync(legacyDups);
      for (const f of files) {
        const oldP = path.join(legacyDups, f);
        const newP = path.join(targetDups, f);
        if (fs.existsSync(oldP)) {
          try { fs.renameSync(oldP, newP); } catch { fs.copyFileSync(oldP, newP); try { fs.unlinkSync(oldP); } catch {} }
        }
      }
      try { fs.rmdirSync(legacyDups); } catch {}
    } catch (e) {}
  }
}
