import { z } from 'zod';

// Personal prompt personalization — the private counterpart to the committed, generic
// prompts/ templates.
//
// The files in prompts/ are PUBLIC and committed: they must stay free of any real employer,
// bank product code, school, clinic, or filename prefix belonging to the person running this
// instance. Those signals are still valuable to the classifier though, so they live in a
// gitignored `.prompts.private.json` (see CONFIG.PROMPTS_PRIVATE_FILE) and are rendered into
// two explicit placeholders at prompt-build time:
//
//   {{USER_PRIORITY_RULES}}  in prompts/classification_rules.md  <- renderPriorityRulesBlock
//   {{USER_KNOWN_ENTITIES}}  in prompts/micro_prompt_entity.md   <- renderKnownEntitiesBlock
//
// Same public-base + private-overlay split as categories.json / .categories.private.json
// (see infrastructure/categories-store.ts). Both placeholders resolve to an empty string when
// the private file is absent, so a fresh clone gets a working, fully generic prompt.

const PriorityRuleSchema = z.object({
  // Literal strings to look for in the document text or filename (bank product codes, scan
  // filename prefixes, employer names, bilingual document titles — whatever is specific to
  // this user's corpus and therefore cannot ship in the committed prompt).
  keywords: z.array(z.string()).min(1),
  category: z.string().min(1),
  // Optional: a keyword set can pin only the top-level category and leave the subcategory to
  // the normal entity-driven resolution.
  subcategory: z.string().optional(),
  // Optional free-text clarification appended to the rendered rule (e.g. a caveat about what
  // NOT to match).
  note: z.string().optional(),
});

export const PromptPersonalizationSchema = z.object({
  // Real issuing entities from this user's own documents — employers, clinics, schools,
  // small companies — that a generic entity dictionary cannot know about. Fed to Step A
  // (entity extraction) as recognition hints.
  known_entities: z.array(z.string()).optional().default([]),
  // High-priority keyword -> category/subcategory overrides, evaluated by the model BEFORE
  // the generic STEP 1..13 decision flow.
  priority_rules: z.array(PriorityRuleSchema).optional().default([]),
  // Escape hatch for rules that don't fit the keyword/category shape. Injected verbatim
  // (as Markdown) at the end of the priority-rules block.
  extra_rules_text: z.string().optional().default(''),
});

export type PriorityRule = z.infer<typeof PriorityRuleSchema>;
export type PromptPersonalization = z.infer<typeof PromptPersonalizationSchema>;

export const EMPTY_PROMPT_PERSONALIZATION: PromptPersonalization =
  PromptPersonalizationSchema.parse({});

function quoteList(values: string[]): string {
  return values.map(v => `"${v.trim()}"`).join(', ');
}

/**
 * Renders the {{USER_PRIORITY_RULES}} block for prompts/classification_rules.md.
 *
 * Returns '' when there is nothing to inject — the placeholder must vanish cleanly rather
 * than leave an empty, confusing "STEP 0" heading in the prompt.
 */
export function renderPriorityRulesBlock(p: PromptPersonalization): string {
  const rules = p.priority_rules.filter(r => r.keywords.some(k => k.trim().length > 0));
  const extra = p.extra_rules_text.trim();
  if (rules.length === 0 && !extra) return '';

  const lines: string[] = [
    '',
    'STEP 0: USER-SPECIFIC HIGH-PRIORITY OVERRIDES (EVALUATE BEFORE STEP 1):',
    '- These keyword sets come from this archive\'s own documents. If one matches, apply it and SKIP the remaining steps.',
    '- ⚠️ EXCEPTION — STEP 1 STILL WINS: if the document is itself a bank statement, classify it under STEP 1 and treat any name matched here as transaction-row noise. A non-bank override never beats a bank statement.',
  ];

  for (const rule of rules) {
    const keywords = quoteList(rule.keywords.filter(k => k.trim().length > 0));
    const target = rule.subcategory
      ? `Category = '${rule.category}', Subcategory = '${rule.subcategory}'`
      : `Category = '${rule.category}' (resolve the Subcategory from the issuing entity as usual)`;
    lines.push(`- IF the document text or filename contains ${keywords} -> ${target}.${rule.note ? ` ${rule.note.trim()}` : ''}`);
  }

  if (extra) lines.push(extra);

  return lines.join('\n') + '\n';
}

/**
 * Deterministic counterpart to the rendered STEP 0 block: matches the same overlay rules against
 * a document so `ruleBasedClassify` (the Ollama-down fallback) honours them too. Golden Rule #6
 * requires the prompt and the fallback to stay logically aligned — without this, the fallback
 * would silently keep classifying by signals the prompt no longer carries.
 *
 * Only rules with an explicit `subcategory` are returned: a rule that defers subcategory
 * resolution to the issuing entity has nothing for a regex-based classifier to act on, and
 * guessing one would manufacture a subcategory the document never supported.
 *
 * `combined` is the caller's lowercased filename + text haystack.
 */
export function matchPriorityRules(
  combined: string,
  p: PromptPersonalization
): { categorie: string; subcategorie: string; keyword: string } | null {
  for (const rule of p.priority_rules) {
    if (!rule.subcategory) continue;
    for (const raw of rule.keywords) {
      const keyword = raw.trim().toLowerCase();
      if (!keyword) continue;
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Boundaries exclude adjacent LETTERS, not digits. A keyword must not match inside a
      // longer word — "gan" may not fire on "organization" — but the codes these rules exist
      // for are routinely glued to a date or account number ("recXX20240424",
      // "STMT_CHK_101"), and a digit-excluding boundary would never match those. A separator
      // ("stmt_", "c/c ") needs no trailing guard at all.
      const trailing = /\p{L}$/u.test(keyword) ? '(?!\\p{L})' : '';
      const leading = /^\p{L}/u.test(keyword) ? '(?<!\\p{L})' : '';
      if (new RegExp(`${leading}${escaped}${trailing}`, 'iu').test(combined)) {
        return { categorie: rule.category, subcategorie: rule.subcategory, keyword };
      }
    }
  }
  return null;
}

/**
 * Renders the {{USER_KNOWN_ENTITIES}} block for prompts/micro_prompt_entity.md.
 *
 * Returns '' when no entities are configured, so the committed generic prompt reads correctly
 * on a fresh clone.
 */
export function renderKnownEntitiesBlock(p: PromptPersonalization): string {
  const entities = p.known_entities.map(e => e.trim()).filter(Boolean);
  if (entities.length === 0) return '';

  return `\nKNOWN ISSUING ENTITIES IN THIS ARCHIVE (prefer an exact match from this list when the document text supports it — but never force one that the text does not actually contain): ${quoteList(entities)}.\n`;
}
