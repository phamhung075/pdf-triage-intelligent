import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchRelevantDocuments, buildPromptContext, processChatQuery, retrieveDocuments, dedupeByPeriod } from './ai-chat-assistant.js';
import * as dbModule from '../infrastructure/db/database.js';
import * as ollamaModule from '../infrastructure/ollama-client.js';
import * as plannerModule from './chat-query-planner.js';

vi.mock('../infrastructure/db/database.js', async () => {
  const actual = await vi.importActual('../infrastructure/db/database.js') as any;
  return {
    ...actual,
    getAllDocuments: vi.fn(),
    searchDocumentsFts: vi.fn()
  };
});

vi.mock('../infrastructure/ollama-client.js', () => ({
  requestClassificationCompletion: vi.fn(),
  requestTextChatCompletion: vi.fn()
}));

vi.mock('./chat-query-planner.js', () => ({ planQuery: vi.fn() }));

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
    // Retrieval now runs through the planned BM25 pipeline rather than the old MCP/search-relevant
    // fallback, so give it a plan and FTS5 result that resolve to the same two pay slips the old
    // isPaySlipQuery branch used to narrow to. This test's subject is citation filtering, not
    // retrieval — the assertions below are unchanged.
    (plannerModule.planQuery as any).mockResolvedValue({
      docTypes: ['bulletin de salaire', 'fiche de paie'], entities: [], keywords: [], notTerms: []
    });
    (dbModule.searchDocumentsFts as any).mockResolvedValue([mockDocs[2], mockDocs[1]]); // ids 3, 2
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

  it('dedupeByPeriod de-duplicates re-scanned copies of the same pay period, keeping the newest scan', () => {
    // The behaviour this test protects moved from searchRelevantDocuments's deleted pay-slip
    // branch into the standalone, exported dedupeByPeriod — same fixture, same expectations.
    const paySlipsWithDuplicate = [
      mockDocs[1], // id 2, May 2026
      mockDocs[2], // id 3, June 2026
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
    ];

    const results = dedupeByPeriod(paySlipsWithDuplicate);
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

  it('dedupeByPeriod preserves input order and leaves non-pay-slip documents untouched, even within the same month', () => {
    const march1 = { id: 10, category: 'housing', date: '2024-03-05', title: 'Invoice A' } as any;
    const march2 = { id: 11, category: 'housing', date: '2024-03-20', title: 'Invoice B' } as any;
    const juneOld = { id: 20, category: 'bulletin_salaire', date: '2026-06-30', title: 'Bulletin Juin (old scan)' } as any;
    const juneRescan = { id: 21, category: 'bulletin_salaire', date: '2026-06-15', title: 'Bulletin Juin (re-scan)' } as any;
    const may = { id: 22, category: 'bulletin_salaire', date: '2026-05-31', title: 'Bulletin Mai' } as any;

    const results = dedupeByPeriod([march1, march2, juneOld, juneRescan, may]);

    // Two invoices in the same month are two invoices, not a duplicate scan — both survive.
    expect(results.map(d => d.id)).toContain(10);
    expect(results.map(d => d.id)).toContain(11);
    // The re-scanned pay slip (higher id) wins over the original scan for the same period.
    expect(results.map(d => d.id)).not.toContain(20);
    expect(results.map(d => d.id)).toContain(21);
    // Input order is preserved — results come back BM25-ranked, and dedup must not reorder them.
    expect(results.map(d => d.id)).toEqual([10, 11, 21, 22]);
  });
});

describe('retrieveDocuments', () => {
  const mockedPlan = () => plannerModule.planQuery as any;
  const mockedFts = () => dbModule.searchDocumentsFts as any;

  beforeEach(() => {
    vi.resetAllMocks();
    // The last-resort token scorer calls getAllDocuments; give it an empty archive by default so
    // only the tests that care about the fallback have to think about it.
    (dbModule.getAllDocuments as any).mockResolvedValue([]);
  });

  it('runs the compiled expression through FTS5 and returns its ranked rows', async () => {
    mockedPlan().mockResolvedValue({ docTypes: ['rib'], entities: ['credit mutuel'], keywords: [], notTerms: [] });
    mockedFts().mockResolvedValue([{ id: 4280, title: 'RIB' }]);

    const docs = await retrieveDocuments('RIB credit mutuel');

    expect(mockedFts()).toHaveBeenCalledWith(
      '("rib") AND ("credit mutuel")', expect.anything(), expect.any(Number)
    );
    expect(docs.map(d => d.id)).toEqual([4280]);
  });

  it('passes the taxonomy and date filters through to SQL', async () => {
    mockedPlan().mockResolvedValue({
      docTypes: ['rib'], entities: [], keywords: [], notTerms: [],
      category: 'bank', dateFrom: '2023-01-01', dateTo: '2023-12-31',
    });
    mockedFts().mockResolvedValue([{ id: 1 }]);

    await retrieveDocuments('rib 2023');

    expect(mockedFts()).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ category: 'bank', dateFrom: '2023-01-01', dateTo: '2023-12-31' }),
      expect.any(Number)
    );
  });

  it('climbs the relaxation ladder when the first query returns nothing', async () => {
    mockedPlan().mockResolvedValue({ docTypes: ['rib'], entities: ['ccm'], keywords: ['2023'], notTerms: [] });
    mockedFts().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 7 }]);

    const docs = await retrieveDocuments('rib ccm 2023');

    expect(mockedFts()).toHaveBeenCalledTimes(2);
    expect(mockedFts().mock.calls[1][0]).not.toContain('2023');
    expect(docs.map(d => d.id)).toEqual([7]);
  });

  it('falls back to the token scorer when FTS5 throws, never surfacing an error', async () => {
    mockedPlan().mockResolvedValue({ docTypes: ['rib'], entities: [], keywords: [], notTerms: [] });
    mockedFts().mockRejectedValue(new Error('no such module: fts5'));
    (dbModule.getAllDocuments as any).mockResolvedValue([
      { id: 99, title: 'RIB Banque', category: 'bank', subcategory: 'x', date: '2024-01-01', summary: '' },
    ]);

    const docs = await retrieveDocuments('rib');

    expect(docs).toBeInstanceOf(Array);
    expect(dbModule.getAllDocuments).toHaveBeenCalled();
  });

  it('honours an explicit count in the user words over the model limit', async () => {
    mockedPlan().mockResolvedValue({ docTypes: ['bulletin'], entities: [], keywords: [], notTerms: [], limit: 10 });
    // Six pay slips across six distinct months: more candidates than the user asked for, so the
    // over-fetch headroom has real duplicates to absorb before the result is capped at 3.
    mockedFts().mockResolvedValue(
      ['2025-07-31', '2025-08-31', '2025-09-30', '2025-10-31', '2025-11-30', '2025-12-31'].map(
        (date, i) => ({ id: i + 1, title: `Bulletin ${date}`, category: 'bulletin_salaire', subcategory: 'acme', date, summary: '', new_path: '' })
      )
    );

    const docs = await retrieveDocuments('les 3 derniers bulletins de salaire');

    // The user's explicit count (3) wins over the model limit (10): retrieval over-fetches with
    // headroom so dedupe can collapse re-scanned months, but the returned set is capped at the
    // requested count.
    expect(docs.length).toBe(3);
    expect(mockedFts().mock.calls[0][2]).toBeGreaterThan(3);
  });

  it('does not read the French indefinite article as a request for exactly one document', async () => {
    // "j'ai besoin d'un RIB" is not a request for one document, it is a request for RIBs. Reading
    // it as a count of 1 would cap the search at a single row and drop the second RIB in the
    // archive — the exact document this whole change exists to surface.
    mockedPlan().mockResolvedValue({ docTypes: ['rib'], entities: [], keywords: [], notTerms: [] });
    mockedFts().mockResolvedValue([]);

    await retrieveDocuments("j'ai besoin d'un RIB");

    expect(mockedFts().mock.calls[0][2]).toBeGreaterThan(1);
  });

  it('still reads an explicit singular request as one document', async () => {
    mockedPlan().mockResolvedValue({ docTypes: ['bulletin'], entities: [], keywords: [], notTerms: [] });
    // Four distinct months: the singular request must cap the returned set at 1 even though the
    // over-fetch headroom asked FTS for more candidates.
    mockedFts().mockResolvedValue(
      ['2025-06-30', '2025-07-31', '2025-08-31', '2025-09-30'].map(
        (date, i) => ({ id: i + 1, title: `Bulletin ${date}`, category: 'bulletin_salaire', subcategory: 'acme', date, summary: '', new_path: '' })
      )
    );

    const docs = await retrieveDocuments('mon dernier bulletin de salaire');

    expect(docs.length).toBe(1);
    expect(mockedFts().mock.calls[0][2]).toBeGreaterThan(1);
  });
});
