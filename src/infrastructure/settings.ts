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
  INPUT_DIR: customSettings.input_dir || process.env.PDF_INPUT_DIR || path.join(DATA_DIR, 'input'),
  OUTPUT_ROOT_DIR: customSettings.output_root_dir || process.env.PDF_OUTPUT_DIR || path.join(DATA_DIR, 'organized'),
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

  PORT: parseInt(process.env.PORT || '3971', 10),
  // Security default: bind to localhost only. This server has no authentication — binding to
  // 0.0.0.0 (Express's own default when no host is given to app.listen()) would expose the
  // full API, including document contents and destructive actions (clear registry, delete),
  // to anyone on the same network. Only override this if you specifically want LAN access and
  // understand there is no auth layer protecting it.
  HOST: process.env.PDF_TRIAGE_HOST || '127.0.0.1',

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
  if (current.input_dir) CONFIG.INPUT_DIR = current.input_dir;
  if (current.output_root_dir) CONFIG.OUTPUT_ROOT_DIR = current.output_root_dir;
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
  if (newSettings.input_dir) CONFIG.INPUT_DIR = newSettings.input_dir;
  if (newSettings.output_root_dir) CONFIG.OUTPUT_ROOT_DIR = newSettings.output_root_dir;
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
