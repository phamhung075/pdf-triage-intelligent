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
      subcategory: 'acme_corp',
      date: '2026-05-31',
      summary: 'Monthly pay slip AcmeCorp',
      total_amount: '2450.00',
      original_filename: '2026-05-31_AcmeCorp_Bulletin_de_Salaire_Mai.pdf',
      new_path: 'C:\\archive\\bulletin_salaire\\acme_corp\\2026\\2026-05-31_AcmeCorp_Bulletin_de_Salaire_Mai.pdf'
    },
    {
      id: 3,
      checksum: 'abc3',
      title: 'Bulletin de Salaire Juin 2026',
      category: 'bulletin_salaire',
      subcategory: 'acme_corp',
      date: '2026-06-30',
      summary: 'June pay slip AcmeCorp',
      total_amount: '2450.00',
      original_filename: '2026-06-30_AcmeCorp_Bulletin_de_Salaire_Juin.pdf',
      new_path: 'C:\\archive\\bulletin_salaire\\acme_corp\\2026\\2026-06-30_AcmeCorp_Bulletin_de_Salaire_Juin.pdf'
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

  it('buildPromptContext grounds the system prompt in the current date so the model can resolve relative time expressions like "3 derniers mois"', () => {
    const { system } = buildPromptContext('3 derniers mois', mockDocs, new Date('2026-08-12T00:00:00'));
    expect(system).toContain('Nous sommes le 2026-08-12');
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

  it('does not silently drop correctly-retrieved documents when the AI under-cites an explicit-count request (citation-pruning regression)', async () => {
    // User asked for 3, the retrieval correctly found 3, but the model's prose only tagged 2 of
    // them — this used to make the 3rd (a real, correctly-retrieved document) vanish from the UI.
    (dbModule.getAllDocuments as any).mockResolvedValue([
      ...mockDocs,
      {
        id: 4, checksum: 'abc4', title: 'Bulletin de Salaire Avril 2026', category: 'bulletin_salaire',
        subcategory: 'acme_corp', date: '2026-04-30', summary: 'April pay slip AcmeCorp',
        total_amount: '2450.00', original_filename: '2026-04-30_AcmeCorp_Bulletin.pdf',
        new_path: 'C:\\archive\\bulletin_salaire\\acme_corp\\2026\\2026-04-30_AcmeCorp_Bulletin.pdf'
      }
    ]);
    (ollamaModule.requestTextChatCompletion as any).mockResolvedValue({
      response: 'Voici : [Doc #3: Bulletin de Salaire Juin 2026] et [Doc #2: Bulletin de Salaire Mai 2026]'
    });

    const res = await processChatQuery('3 fiche de paie');
    expect(res.matchedDocuments.length).toBe(3);
    expect(res.matchedDocuments.map((d: any) => d.id).sort()).toEqual([2, 3, 4]);
  });

  it('searchRelevantDocuments de-duplicates re-scanned copies of the same pay period before applying the top-N limit', async () => {
    (dbModule.getAllDocuments as any).mockResolvedValue([
      ...mockDocs,
      { // a re-scanned duplicate of the June 2026 slip (id 3) under a different filename/checksum
        id: 5, checksum: 'abc5-dup', title: 'BULLETIN DE SALAIRE JUIN 2026', category: 'bulletin_salaire',
        subcategory: 'acme_corp', date: '2026-06-30', summary: 'duplicate scan', total_amount: '2450.00',
        original_filename: 'converted.pdf', new_path: 'C:\\archive\\bulletin_salaire\\acme_corp\\2026\\converted.pdf'
      },
      {
        id: 6, checksum: 'abc6', title: 'Bulletin de Salaire Avril 2026', category: 'bulletin_salaire',
        subcategory: 'acme_corp', date: '2026-04-30', summary: 'April pay slip', total_amount: '2450.00',
        original_filename: '2026-04-30_AcmeCorp_Bulletin.pdf',
        new_path: 'C:\\archive\\bulletin_salaire\\acme_corp\\2026\\2026-04-30_AcmeCorp_Bulletin.pdf'
      }
    ]);

    const results = await searchRelevantDocuments('3 derniers fiche de paie');
    // Without de-dup, the two June 2026 copies (ids 3 and 5) would occupy 2 of the 3 slots and
    // push April (id 6) out even though it's a distinct month that should be included.
    expect(results.length).toBe(3);
    const months = results.map(d => d.date);
    expect(new Set(months).size).toBe(3); // May, June, April — three distinct months, not two
    expect(months).toContain('2026-04-30');
    // The newest copy of the duplicated June slip (id 5) wins over the older one (id 3).
    expect(results.map(d => d.id)).not.toContain(3);
    expect(results.map(d => d.id)).toContain(5);
  });
});
