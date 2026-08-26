import { describe, it, expect } from 'vitest';
import { StructuredQuerySchema, buildFtsMatchExpression, planQueryHeuristic, relaxQuery, type StructuredQuery } from './chat-query.js';

function q(overrides: Partial<StructuredQuery> = {}): StructuredQuery {
  return { docTypes: [], entities: [], keywords: [], notTerms: [], ...overrides };
}

describe('StructuredQuerySchema', () => {
  it('fills the four term arrays with empty defaults when absent', () => {
    const parsed = StructuredQuerySchema.parse({});
    expect(parsed).toEqual({ docTypes: [], entities: [], keywords: [], notTerms: [] });
  });

  it('accepts explicit null on optional string fields, as Qwen frequently emits', () => {
    const parsed = StructuredQuerySchema.parse({ category: null, dateFrom: null });
    expect(parsed.category).toBeUndefined();
    expect(parsed.dateFrom).toBeUndefined();
  });

  it('accepts an explicit null term array, which Qwen emits as often as it omits the key', () => {
    const parsed = StructuredQuerySchema.parse({ docTypes: null, keywords: ['rib'] });
    expect(parsed.docTypes).toEqual([]);
    expect(parsed.keywords).toEqual(['rib']);
  });

  it('coerces a stringified limit and rejects an absurd one', () => {
    expect(StructuredQuerySchema.parse({ limit: '3' }).limit).toBe(3);
    expect(StructuredQuerySchema.parse({ limit: 9999 }).limit).toBeUndefined();
  });

  it('drops non-string entries inside a term array instead of throwing', () => {
    expect(StructuredQuerySchema.parse({ keywords: ['rib', 42, null] }).keywords).toEqual(['rib']);
  });
});

describe('buildFtsMatchExpression', () => {
  it('ORs terms inside a facet and ANDs the facets', () => {
    expect(buildFtsMatchExpression(q({ docTypes: ['rib'], entities: ['credit mutuel'] })))
      .toBe('("rib") AND ("credit mutuel")');
  });

  it('reproduces the expression proven against the real index', () => {
    expect(buildFtsMatchExpression(q({
      docTypes: ['rib', 'identité bancaire'],
      entities: ['mutuel', 'credit mutuel'],
    }))).toBe('("rib" OR "identité bancaire") AND ("mutuel" OR "credit mutuel")');
  });

  it('parenthesises the positive part before NOT, because FTS5 binds NOT tighter than AND', () => {
    // Without the outer parens, `A AND B NOT C` parses as `A AND (B NOT C)` and the
    // exclusion would only apply to the second facet.
    expect(buildFtsMatchExpression(q({
      docTypes: ['rib'],
      entities: ['mutuel'],
      notTerms: ['relevé de compte'],
    }))).toBe('(("rib") AND ("mutuel")) NOT ("relevé de compte")');
  });

  it('returns null when every facet is empty, so the caller knows no FTS query is possible', () => {
    expect(buildFtsMatchExpression(q())).toBeNull();
    expect(buildFtsMatchExpression(q({ notTerms: ['x'] }))).toBeNull();
  });

  it('escapes embedded double quotes by doubling them', () => {
    expect(buildFtsMatchExpression(q({ keywords: ['le "vrai" doc'] })))
      .toBe('("le ""vrai"" doc")');
  });

  it.each([
    ['a NEAR/2 b'], ['col:value'], ['wild*card'], ['(paren)'], ['dash-term'],
    ['AND'], ['OR'], ['NOT'], ['^caret'], ['a AND b OR c'],
  ])('neutralises FTS5 syntax in %j by quoting it as a phrase', (term) => {
    const expr = buildFtsMatchExpression(q({ keywords: [term] }));
    expect(expr).toBe(`("${term}")`);
  });

  it('drops terms with no alphanumeric content, which tokenise to nothing and error the MATCH', () => {
    expect(buildFtsMatchExpression(q({ keywords: ['???', '  ', '-', 'rib'] }))).toBe('("rib")');
  });

  it('drops a facet that becomes empty after filtering rather than emitting ()', () => {
    expect(buildFtsMatchExpression(q({ docTypes: ['???'], entities: ['mutuel'] })))
      .toBe('("mutuel")');
  });

  it('trims surrounding whitespace and de-duplicates case-insensitively within a facet', () => {
    expect(buildFtsMatchExpression(q({ keywords: ['  RIB  ', 'rib', 'Rib'] }))).toBe('("RIB")');
  });
});

describe('planQueryHeuristic', () => {
  it('drops French stopwords and the filler that polluted the old scorer', () => {
    const plan = planQueryHeuristic("RIB de credit mutuel j'ai besoin");
    expect(plan.keywords).not.toContain('besoin');
    expect(plan.keywords).not.toContain('de');
    expect(plan.keywords.map(k => k.toLowerCase())).toEqual(
      expect.arrayContaining(['rib', 'credit', 'mutuel'])
    );
  });

  it('promotes a token matching a known tag into the entities facet', () => {
    const plan = planQueryHeuristic('relevé credit_mutuel 2023', ['credit_mutuel', 'rib']);
    expect(plan.entities).toContain('credit_mutuel');
    expect(plan.keywords).not.toContain('credit_mutuel');
  });

  it('extracts a bare year into an ISO date range and out of the keywords', () => {
    const plan = planQueryHeuristic('relevé de compte 2023');
    expect(plan.dateFrom).toBe('2023-01-01');
    expect(plan.dateTo).toBe('2023-12-31');
    expect(plan.keywords).not.toContain('2023');
  });

  it('ignores a 4-digit number that is not a plausible document year', () => {
    const plan = planQueryHeuristic('facture 9999');
    expect(plan.dateFrom).toBeUndefined();
  });

  it('produces a compilable expression for a realistic query', () => {
    expect(buildFtsMatchExpression(planQueryHeuristic('bulletin de salaire'))).not.toBeNull();
  });

  it('returns an all-empty plan for a message of pure stopwords, so the caller falls back', () => {
    const plan = planQueryHeuristic("j'ai besoin de le la les");
    expect(buildFtsMatchExpression(plan)).toBeNull();
  });
});

describe('relaxQuery', () => {
  const full: StructuredQuery = {
    docTypes: ['rib'], entities: ['credit mutuel'], keywords: ['2023'], notTerms: ['relevé'],
  };

  it('drops keywords first — the weakest facet', () => {
    const r = relaxQuery(full)!;
    expect(r.keywords).toEqual([]);
    expect(r.notTerms).toEqual(['relevé']);
    expect(r.entities).toEqual(['credit mutuel']);
  });

  it('drops notTerms second', () => {
    const r = relaxQuery(relaxQuery(full)!)!;
    expect(r.notTerms).toEqual([]);
    expect(r.entities).toEqual(['credit mutuel']);
  });

  it('drops entities third, keeping the document type longest', () => {
    const r = relaxQuery(relaxQuery(relaxQuery(full)!)!)!;
    expect(r.entities).toEqual([]);
    expect(r.docTypes).toEqual(['rib']);
  });

  it('returns null once only docTypes remain, so the ladder terminates', () => {
    let q: StructuredQuery | null = full;
    for (let i = 0; i < 3; i++) q = relaxQuery(q!);
    expect(relaxQuery(q!)).toBeNull();
  });

  it('preserves the taxonomy and date filters at every rung', () => {
    const r = relaxQuery({ ...full, category: 'bank', dateFrom: '2023-01-01' })!;
    expect(r.category).toBe('bank');
    expect(r.dateFrom).toBe('2023-01-01');
  });
});
