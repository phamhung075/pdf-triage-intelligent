import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../infrastructure/ollama-client.js', () => ({
  requestTextChatCompletion: vi.fn(),
}));
vi.mock('../infrastructure/categories-store.js', () => ({
  getCategoriesConfig: () => ({ categories: [{ id: 'bank' }, { id: 'identity' }] }),
}));

import { requestTextChatCompletion } from '../infrastructure/ollama-client.js';
import { buildPlannerPrompt, planQuery } from './chat-query-planner.js';

const mocked = vi.mocked(requestTextChatCompletion);

beforeEach(() => vi.clearAllMocks());

describe('buildPlannerPrompt', () => {
  it('lists the live taxonomy so the model cannot invent a category', () => {
    const { system } = buildPlannerPrompt('rib', ['bank', 'identity'], new Date('2026-08-26'));
    expect(system).toContain('bank');
    expect(system).toContain('identity');
  });

  it('grounds the prompt in the current date for relative expressions', () => {
    const { system } = buildPlannerPrompt('les 3 derniers mois', ['bank'], new Date('2026-08-26'));
    expect(system).toContain('2026');
  });

  it('contains no personal entity — the taxonomy is the only source of names', () => {
    const { system, userPrompt } = buildPlannerPrompt('rib', ['bank'], new Date('2026-08-26'));
    expect(`${system}\n${userPrompt}`.toLowerCase()).not.toMatch(/paribas|mutuel|foncia/);
  });
});

describe('planQuery', () => {
  it('parses a well-formed plan from the model', async () => {
    mocked.mockResolvedValue({ response: JSON.stringify({
      docTypes: ['rib'], entities: ['credit mutuel'], keywords: [], notTerms: ['relevé de compte'],
    }) });
    const plan = await planQuery('RIB credit mutuel');
    expect(plan.docTypes).toEqual(['rib']);
    expect(plan.notTerms).toEqual(['relevé de compte']);
  });

  it('unwraps a plan the model fenced in a markdown code block', async () => {
    mocked.mockResolvedValue({ response: '```json\n{"docTypes":["rib"]}\n```' });
    expect((await planQuery('rib')).docTypes).toEqual(['rib']);
  });

  it('falls back to the heuristic planner when Ollama is unreachable', async () => {
    mocked.mockRejectedValue(new Error('ECONNREFUSED'));
    const plan = await planQuery("RIB de credit mutuel j'ai besoin");
    expect(plan.keywords.map(k => k.toLowerCase())).toContain('rib');
    expect(plan.keywords).not.toContain('besoin');
  });

  it('falls back to the heuristic planner when the model returns unparseable text', async () => {
    mocked.mockResolvedValue({ response: 'Bien sûr ! Voici votre RIB.' });
    expect((await planQuery('rib credit mutuel')).keywords.length).toBeGreaterThan(0);
  });

  it('falls back when the model returns valid JSON that yields no searchable facet', async () => {
    mocked.mockResolvedValue({ response: '{"docTypes":[],"entities":[],"keywords":[]}' });
    expect((await planQuery('rib credit mutuel')).keywords.length).toBeGreaterThan(0);
  });

  it('never throws, whatever the model does', async () => {
    mocked.mockResolvedValue({ response: null as unknown as string });
    await expect(planQuery('rib')).resolves.toBeDefined();
  });
});
