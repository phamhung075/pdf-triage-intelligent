import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchRelevantDocuments, buildPromptContext, processChatQuery } from './ai-chat-assistant.js';
import * as dbModule from '../infrastructure/db/database.js';
import * as ollamaModule from '../infrastructure/ollama-client.js';

vi.mock('../infrastructure/db/database.js', async () => {
  const actual = await vi.importActual('../infrastructure/db/database.js') as any;
  return {
    ...actual,
    getAllDocuments: vi.fn()
  };
});

vi.mock('../infrastructure/ollama-client.js', () => ({
  requestClassificationCompletion: vi.fn(),
  requestTextChatCompletion: vi.fn()
}));

describe('ai-chat-assistant', () => {
  const mockDocs: any[] = [
    {
      id: 1,
      checksum: 'abc1',
      title: 'Facture EDF Electricite',
      category: 'housing',
      subcategory: 'edf',
      date: '2024-01-15',
      summary: 'Invoice for electricity',
      total_amount: '85.50',
      original_filename: '2024-01-15_EDF_Facture.pdf',
      new_path: 'C:\\archive\\housing\\edf\\2024\\2024-01-15_EDF_Facture.pdf'
    },
    {
      id: 2,
      checksum: 'abc2',
      title: 'Bulletin de Salaire Mai 2026',
      category: 'bulletin_salaire',
      subcategory: 'employeur_x',
      date: '2026-05-31',
      summary: 'Monthly pay slip EmployeurX',
      total_amount: '2450.00',
      original_filename: '2026-05-31_EmployeurX_Bulletin_de_Salaire_Mai.pdf',
      new_path: 'C:\\archive\\bulletin_salaire\\employeur_x\\2026\\2026-05-31_EmployeurX_Bulletin_de_Salaire_Mai.pdf'
    },
    {
      id: 3,
      checksum: 'abc3',
      title: 'Bulletin de Salaire Juin 2026',
      category: 'bulletin_salaire',
      subcategory: 'employeur_x',
      date: '2026-06-30',
      summary: 'June pay slip EmployeurX',
      total_amount: '2450.00',
      original_filename: '2026-06-30_EmployeurX_Bulletin_de_Salaire_Juin.pdf',
      new_path: 'C:\\archive\\bulletin_salaire\\employeur_x\\2026\\2026-06-30_EmployeurX_Bulletin_de_Salaire_Juin.pdf'
    }
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    (dbModule.getAllDocuments as any).mockResolvedValue(mockDocs);
  });

  it('searchRelevantDocuments filters and sorts pay slips by date descending', async () => {
    const results = await searchRelevantDocuments('j\'ai besoin 2 derniers fiche de paie');
    expect(results.length).toBe(2);
    expect(results[0].id).toBe(3); // 2026-06-30
    expect(results[1].id).toBe(2); // 2026-05-31
  });

  it('buildPromptContext embeds document metadata into prompt', () => {
    const { system, userPrompt } = buildPromptContext('Show my pay slip', mockDocs);
    expect(system).toContain('assistant archiviste IA local');
    expect(userPrompt).toContain('Bulletin de Salaire Mai 2026');
  });

  it('processChatQuery calls Ollama and returns answer with exact cited documents', async () => {
    (ollamaModule.requestTextChatCompletion as any).mockResolvedValue({
      response: 'Voici votre bulletin : [Doc #3: Bulletin de Salaire Juin 2026]'
    });

    const res = await processChatQuery('j\'ai besoin fiche de paie');
    expect(res.answer).toContain('Bulletin de Salaire Juin 2026');
    expect(res.matchedDocuments.length).toBe(1);
    expect(res.matchedDocuments[0].id).toBe(3);
  });
});
