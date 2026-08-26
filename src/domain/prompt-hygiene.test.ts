import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../infrastructure/settings.js';

// Regression guard for the public/private split: the committed tree is publishable, while the
// personal signals live in gitignored overlays (`.prompts.private.json`, `.categories.private.json`,
// `settings.json`) — see docs/knowledge/taxonomy.md#personal-prompt-overlay.
//
// The guard checks against CONFIG.PERSONAL_NAME_DENYLIST — which itself lives in the gitignored
// settings.json — so it needs no personal token written into this committed test file.
//
// Tokens shorter than 4 chars are skipped: a 3-letter name fragment matches innocent substrings of
// ordinary words (e.g. "thinking"), and a word-boundary match would in turn miss the real leak
// shape, which is a name fused into a scan filename prefix or an OCR fixture. 4+ chars is the
// length where plain substring matching is both safe and able to catch that shape.
const DENY_TOKENS = CONFIG.PERSONAL_NAME_DENYLIST.filter(t => t.length >= 4).map(t => t.toLowerCase());

const REPO_ROOT = process.cwd();

// Committed roots that must stay publishable. The gitignored personal overlays are deliberately
// absent from this list — they are where the real values are supposed to live.
const SCAN_ROOTS = ['src', 'prompts', 'public', 'docs'];
const SCAN_FILES = [
  'CLAUDE.md', 'AGENTS.md', 'AGENT_REQUIREMENTS.md',
  'categories.json', 'entity_dictionary.json', 'prompts.private.json.example',
];

// docs/skills is a directory junction into the vendored superpowers plugin — third-party material,
// not this project's committed source. public/js/vendor is likewise vendored.
const SKIP_DIRS = new Set(['skills', 'vendor', 'node_modules', 'dist']);
const TEXT_EXT = /\.(ts|js|json|md|html|css|scss)$/;

function collect(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      collect(full, out);
    } else if (TEXT_EXT.test(entry.name) && !entry.name.startsWith('.')) {
      out.push(full);
    }
  }
}

function committedTextFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) collect(path.join(REPO_ROOT, root), files);
  for (const file of SCAN_FILES) {
    const full = path.join(REPO_ROOT, file);
    if (fs.existsSync(full)) files.push(full);
  }
  return files;
}

describe('the committed tree stays publishable', () => {
  const files = committedTextFiles();

  it('finds files to check', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('contains no owner/household name from PERSONAL_NAME_DENYLIST', () => {
    if (DENY_TOKENS.length === 0) return; // No denylist configured (fresh clone) — nothing to assert.

    const offenders: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8').toLowerCase();
      if (DENY_TOKENS.some(token => content.includes(token))) {
        // The path alone — never the matched token — so the failure message stays publishable.
        offenders.push(path.relative(REPO_ROOT, file).replace(/\\/g, '/'));
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('the prompt/classifier contract', () => {
  it('declares the overlay placeholders the personalization store feeds', () => {
    const classificationRules = fs.readFileSync(path.join(CONFIG.PROMPTS_DIR, 'classification_rules.md'), 'utf-8');
    const entityPrompt = fs.readFileSync(path.join(CONFIG.PROMPTS_DIR, 'micro_prompt_entity.md'), 'utf-8');

    expect(classificationRules).toContain('{{USER_PRIORITY_RULES}}');
    expect(entityPrompt).toContain('{{USER_KNOWN_ENTITIES}}');
  });

  it('has the deterministic fallback read its user-specific overrides from the overlay', () => {
    // Golden Rule #6 requires the prompt and ruleBasedClassify to stay logically aligned. Both
    // now read one source; a future hardcoded literal here would silently break that.
    const classifier = fs.readFileSync(path.join(REPO_ROOT, 'src', 'domain', 'classification.ts'), 'utf-8');
    expect(classifier).toContain('matchPriorityRules');
  });
});
