import { describe, it, expect } from 'vitest';
import { StructuredQuerySchema, buildFtsMatchExpression, type StructuredQuery } from './chat-query.js';

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
