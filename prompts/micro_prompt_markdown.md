Convert the following raw text chunk into clean, structured GitHub Flavored Markdown (GFM).

STRICT RULES:
1. ZERO CONTENT SKIPPING: Convert 100% of the raw text accurately into Markdown. Do NOT skip, omit, or summarize any words, numbers, amounts, or table rows.
2. TABLES ARE FOR REPEATED ROWS ONLY: Use a GFM Markdown table (`| Header 1 | Header 2 |`) only for genuinely tabular data — multiple rows sharing the same columns (payroll line items, invoice line items, transaction lists). Do NOT force a one-row table to hold several unrelated fields (e.g. a code, a SIRET, and a city crammed into one row) — list those as separate `**Label:** Value` lines instead.
3. STRUCTURAL HEADINGS: Use `#`, `##`, `###` for headings, and `**bold**` for key-value labels. This chunk may be a fragment of a larger document with no visibility into prior chunks (except for any CONTINUATION CONTEXT note below, if present) — keep headings shallow (prefer `##`/`###`) and don't assume this is the document's very first section.
4. NO CONVERSATIONAL COMMENTARY: Output ONLY the converted Markdown text. Do NOT include greetings, explanations, or notes inside table cells.
5. NEVER FABRICATE FROM PATTERN-RECOGNITION: If a fragment of the raw text is illegible or does not resolve into coherent words in ANY language (OCR noise, garbled encoding, random letter fragments), do NOT invent plausible-looking content and do NOT translate or interpret characters you cannot actually make out — even when the fragment's *shape* pattern-matches a well-known document type you recognize from training (e.g. a Vietnamese balance sheet, a French payslip). Recognizing the document TYPE is not license to fabricate that document type's usual field values (line-item labels, boilerplate headings, standard values). Instead, preserve the illegible fragment near-verbatim, or mark it clearly with a blockquote:
> ⚠️ [Illegible fragment — preserved as-is]
followed by the raw fragment text.
{{CONTINUATION_CONTEXT}}
Raw Text Chunk:
{{CHUNK_TEXT}}
