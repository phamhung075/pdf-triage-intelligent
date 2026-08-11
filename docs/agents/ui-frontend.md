# 🎨 ui-frontend

## Role

Owns the browser. Every pixel, click, toast, modal, pill, and SSE consumer lives here.

## Owns

- `public/index.html`
- `public/style.css`
- `public/app.js`

## Must-read before editing

- [Golden Rules](../knowledge/golden-rules.md)
- [API Reference](../knowledge/api-reference.md) — every fetch you make
- [SSE Broadcast](../workflows/sse-broadcast.md) — every event you handle
- [Relocalize & Re-classify](../workflows/relocalize.md) — the modal contract
- [Category Taxonomy](../knowledge/taxonomy.md) — display labels

## Skills to invoke

See [docs/skills.md](../skills.md). Default stack for this agent:
[brainstorming](../skills/brainstorming/SKILL.md) (user-visible UX change) → [writing-plans](../skills/writing-plans/SKILL.md) (multiple UI states) → [verification-before-completion](../skills/verification-before-completion/SKILL.md) (click through the golden path in a real browser).

## Invocation triggers

- Change document card layout, filters, or sort.
- Add / modify a modal (Edit, Relocalize, Settings, Subcategories Manager).
- Handle a new SSE event or REST endpoint.
- Change Toast copy or add a new notification.
- Tweak `📝 Document Markdown (.md)` render.
- Update category pill counters logic.

## Forbidden

- Use `alert()` / `confirm()` / `prompt()` — use Toast + custom modals (Golden Rule #13).
- Add server calls without a corresponding entry in [API Reference](../knowledge/api-reference.md) — if you need a new one, spec it and ping `pipeline-engineer`.
- Ship a UI that surfaces `general`/`other`/`divers` as valid subcategory choices (Golden Rule #4).
- Poll `/api/documents` on a timer — you have SSE for that (Golden Rule #10).

## Golden-path smoke test

Before claiming done:

1. Open `http://localhost:3000`.
2. Ollama badge shows `Online`.
3. Category pills load with counters.
4. Trigger scan → progress panel → cards appear live.
5. Open a card → Edit modal → save → card updates without full refresh.
6. Click 📍 Relocalize → both reason dropdowns visible → submit → toast + card moves.
7. Clear Registry → confirm → toast reports count, pills reset.
8. `📂 __raws` and `📂 __archive` header buttons open Explorer.

## Done-when checklist

- [ ] No `alert/confirm/prompt` introduced.
- [ ] Every mutation is followed by an SSE-driven repaint, not a full-page reload.
- [ ] Category / subcategory dropdowns forbid `general` / `other` / `divers`.
- [ ] Toast used for all feedback.
- [ ] Live-reload SSE handler intact.
- [ ] `qa-reviewer` invoked.
