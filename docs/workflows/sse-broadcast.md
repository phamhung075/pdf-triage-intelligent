# 📡 SSE Broadcast Contract

## Two streams

| Stream                          | Purpose                                        |
| ------------------------------- | ---------------------------------------------- |
| `GET /api/triage/events`        | Triage progress + registry mutations           |
| `GET /api/dev/livereload`       | Dev-only reload signal on `public/` changes    |

Both are `Content-Type: text/event-stream`, keep-alive, `data: <json>\n\n` frames.

## Event types (triage stream)

### `SCAN_STARTED`

```json
{ "type": "SCAN_STARTED", "totalFiles": 12, "files": ["a.pdf", "b.pdf", …] }
```

### `FILE_PROGRESS`

```json
{ "type": "FILE_PROGRESS", "filename": "a.pdf",
  "stage": "EXTRACTING_TEXT" | "AI_CLASSIFYING" | "RELOCALIZING",
  "message": "…" }
```

### `FILE_COMPLETED`

```json
{ "type": "FILE_COMPLETED", "filename": "a.pdf",
  "stage": "COMPLETED" | "SKIPPED_DUPLICATE",
  "message": "…",
  "docId": 42, "title": "…", "category": "…", "subcategory": "…",
  "newPath": "…" }
```

### `FILE_FAILED`

```json
{ "type": "FILE_FAILED", "filename": "a.pdf",
  "stage": "FAILED",
  "message": "❌ Blocked: …" }
```

### `SCAN_COMPLETED`

```json
{ "type": "SCAN_COMPLETED",
  "scannedCount": 12, "processedCount": 10, "skippedCount": 2 }
```

### `REGISTRY_UPDATED`

Emitted after edits, relocalizes, renames, clears. Optional `action` field: `EDIT | RELOCALIZE | CLEAR | RENAME`.

```json
{ "type": "REGISTRY_UPDATED", "action": "EDIT", "docId": 42 }
```

### `CATEGORIES_UPDATED`

Emitted when `categories.json` changed (auto-create, PUT, rename).

```json
{ "type": "CATEGORIES_UPDATED" }
```

## Sender

`broadcastTriageEvent(event)` in the `httpapi` package — serializes to JSON and writes to every connected client through the mutex-protected SSE hub. Clients are added when the stream opens and removed when it closes.

## Guarantees

- Delivery is best-effort — no ack, no retry.
- Order is preserved per-client.
- Every mutation MUST call `broadcastTriageEvent` at least once (Golden Rule #10). If you add a new mutation endpoint, add the broadcast.

## Client side

`public/ts/TriageEventsManager.ts` (compiled to `public/js/TriageEventsManager.js`) opens an `EventSource('/api/triage/events')` on load. On each event:

- `SCAN_STARTED` → progress panel, spinner on files.
- `FILE_PROGRESS` → per-file stage indicator.
- `FILE_COMPLETED/FAILED` → toast + card update.
- `SCAN_COMPLETED` → toast summary, close progress panel.
- `REGISTRY_UPDATED` → refetch `/api/documents`, `/api/categories`, repaint pills + counters + cards.
- `CATEGORIES_UPDATED` → refetch `/api/categories`, repaint pills.

Reconnects automatically on server restart (EventSource default).

## Livereload stream

Only meaningful in dev. A polling mtime/size watcher over `public/` (the Go replacement for
`fs.watch(publicDir, { recursive: true })`) triggers `data: reload\n\n`; the wire format is
unchanged. Client handler in `public/ts/TriageEventsManager.ts` calls `location.reload()`.

## Owner

Backend broadcasts: [pipeline-engineer](../agents/pipeline-engineer.md).
Client consumers: [ui-frontend](../agents/ui-frontend.md).
