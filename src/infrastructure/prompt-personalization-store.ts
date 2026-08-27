import fs from 'fs';
import { CONFIG } from './settings.js';
import {
  PromptPersonalizationSchema,
  PromptPersonalization,
  EMPTY_PROMPT_PERSONALIZATION,
} from '../domain/prompt-personalization.js';
import { renderTaxonomyConflictHintsBlock } from '../domain/taxonomy-conflicts.js';
import { decisionsToPriorityRules } from '../domain/decision-rule.js';
import { readManualDecisionsSync } from './manual-decisions-store.js';
import { readTaxonomyHintsSync } from './taxonomy-hints-store.js';

// Reads the gitignored `.prompts.private.json` overlay that supplies the personal signals the
// committed prompts/ templates deliberately don't carry (see domain/prompt-personalization.ts
// for the why and prompts.private.json.example for the shape).
//
// An absent file is the normal state for a fresh clone, not an error: the prompts are written
// to read correctly with both injected blocks empty. An INVALID file is logged and treated as
// empty rather than thrown, matching entity-dictionary-store.ts / categories-store.ts — a typo
// in a personalization file must never take the whole triage pipeline down.
//
// On top of the hand-curated file, every ENABLED human move decision (manual_decisions store)
// is appended as a STEP 0 priority rule — the feedback-teaches-AI loop (Golden Rule #18). The
// decisions are injected through the SAME {{USER_PRIORITY_RULES}} block, so the Qwen prompt and
// the deterministic ruleBasedClassify fallback (matchPriorityRules) both see them and stay
// logically aligned. The hand-curated rules come first: deliberate manual curation outranks an
// auto-derived rule when matchPriorityRules resolves ties (first match wins).
export function getPromptPersonalization(): PromptPersonalization {
  let personalization = EMPTY_PROMPT_PERSONALIZATION;
  if (fs.existsSync(CONFIG.PROMPTS_PRIVATE_FILE)) {
    try {
      const raw = fs.readFileSync(CONFIG.PROMPTS_PRIVATE_FILE, 'utf-8');
      personalization = PromptPersonalizationSchema.parse(JSON.parse(raw));
    } catch (e) {
      console.error('Invalid .prompts.private.json, ignoring prompt personalization', e);
    }
  }

  // readManualDecisionsSync returns newest first; decisionsToPriorityRules caps the injection
  // so a growing feedback log cannot bloat the prompt.
  const learned = decisionsToPriorityRules(readManualDecisionsSync());
  if (learned.length > 0) {
    personalization = {
      ...personalization,
      priority_rules: [...personalization.priority_rules, ...learned],
    };
  }

  // Taxonomy duplicate-guard hints (blocked duplicate creations) are appended to the STEP 0
  // block's extra_rules_text: they are taxonomy FACTS ("slug X must map to Y under Z"), not
  // keyword match rules, so they render as instructions the model reads before classifying —
  // the HINT half of the block-then-hint loop (see domain/taxonomy-conflicts.ts).
  const guardBlock = renderTaxonomyConflictHintsBlock(readTaxonomyHintsSync());
  if (guardBlock) {
    personalization = {
      ...personalization,
      extra_rules_text: [
        (personalization.extra_rules_text || '').trim(),
        guardBlock.trim(),
      ].filter(Boolean).join('\n\n') + '\n',
    };
  }
  return personalization;
}
