import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// Defaults to the current working directory (how every npm script in this repo invokes the
// app — `tsx src/index.ts ...` from the project root) so a fresh clone works out of the box.
// PDF_TRIAGE_BASE_DIR overrides this for setups where cwd isn't the project root (e.g. a
// packaged Electron build, or running the compiled output from elsewhere).
export const BASE_DIR = process.env.PDF_TRIAGE_BASE_DIR
  ? path.resolve(process.env.PDF_TRIAGE_BASE_DIR)
  : path.resolve(process.cwd());
export const SETTINGS_FILE = path.join(BASE_DIR, 'settings.json');

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
  INPUT_DIR: customSettings.input_dir || process.env.PDF_INPUT_DIR || path.join(BASE_DIR, 'input'),
  OUTPUT_ROOT_DIR: customSettings.output_root_dir || process.env.PDF_OUTPUT_DIR || path.join(BASE_DIR, 'organized'),
  JSON_REGISTRY_PATH: process.env.PDF_REGISTRY_PATH || path.join(BASE_DIR, 'registry.json'),
  DB_PATH: process.env.PDF_DB_PATH || path.join(BASE_DIR, 'pdf_triage.db'),
  // Public, generic, committed starter taxonomy (top-level categories only, no personal
  // subcategories). CATEGORIES_PRIVATE_FILE holds everything auto-created from the user's own
  // documents (real bank branches, employers, etc.) — gitignored, never committed. See
  // categories-store.ts for how the two are merged on read and diffed on write.
  CATEGORIES_FILE: path.join(BASE_DIR, 'categories.json'),
  CATEGORIES_PRIVATE_FILE: path.join(BASE_DIR, '.categories.private.json'),
  ENTITY_DICTIONARY_FILE: path.join(BASE_DIR, 'entity_dictionary.json'),
  MANUAL_DECISIONS_FILE: path.join(BASE_DIR, 'manual_decisions.json'),
  PROMPTS_DIR: path.join(BASE_DIR, 'prompts'),

  OLLAMA_HOST: customSettings.ollama_host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  OLLAMA_MODEL: sanitizeOllamaModel(customSettings.ollama_model || process.env.OLLAMA_MODEL),
  OLLAMA_EMBED_MODEL: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',

  PORT: parseInt(process.env.PORT || '3971', 10),

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
