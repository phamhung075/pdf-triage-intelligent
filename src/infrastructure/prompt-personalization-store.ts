import fs from 'fs';
import { CONFIG } from './settings.js';
import {
  PromptPersonalizationSchema,
  PromptPersonalization,
  EMPTY_PROMPT_PERSONALIZATION,
} from '../domain/prompt-personalization.js';

// Reads the gitignored `.prompts.private.json` overlay that supplies the personal signals the
// committed prompts/ templates deliberately don't carry (see domain/prompt-personalization.ts
// for the why and prompts.private.json.example for the shape).
//
// An absent file is the normal state for a fresh clone, not an error: the prompts are written
// to read correctly with both injected blocks empty. An INVALID file is logged and treated as
// empty rather than thrown, matching entity-dictionary-store.ts / categories-store.ts — a typo
// in a personalization file must never take the whole triage pipeline down.
export function getPromptPersonalization(): PromptPersonalization {
  if (!fs.existsSync(CONFIG.PROMPTS_PRIVATE_FILE)) return EMPTY_PROMPT_PERSONALIZATION;
  try {
    const raw = fs.readFileSync(CONFIG.PROMPTS_PRIVATE_FILE, 'utf-8');
    return PromptPersonalizationSchema.parse(JSON.parse(raw));
  } catch (e) {
    console.error('Invalid .prompts.private.json, ignoring prompt personalization', e);
    return EMPTY_PROMPT_PERSONALIZATION;
  }
}
