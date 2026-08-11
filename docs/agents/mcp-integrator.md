# 🔌 mcp-integrator

## Role

Owns the MCP stdio server. Exposes the registry to external agents cleanly and safely.

## Owns

- `src/infrastructure/mcp/mcp-server.ts`
- MCP tool schemas and handlers.

## Must-read before editing

- [Golden Rules](../knowledge/golden-rules.md)
- [API Reference](../knowledge/api-reference.md) (MCP tools section)
- [Data Model](../knowledge/data-model.md)
- [Triage Pipeline](../workflows/triage-pipeline.md) (`trigger_triage` calls into it)

## Skills to invoke

See [docs/skills.md](../skills.md). Default stack for this agent:
[writing-plans](../skills/writing-plans/SKILL.md) (new tool) → [test-driven-development](../skills/test-driven-development/SKILL.md) (input validation) → [verification-before-completion](../skills/verification-before-completion/SKILL.md) (dry-run each tool via stdio).

## Invocation triggers

- Add a new MCP tool.
- Change a tool's inputSchema.
- Fix an MCP handler error path.
- Wire an MCP tool to a new DB helper.

## Forbidden

- Start the web server from the MCP entrypoint (they run independently).
- Emit SSE from an MCP handler (there is no SSE over stdio) — but you MUST still call `syncJSONRegistry()` on mutations.
- Return non-JSON payloads. Every response is `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`.
- Skip Zod validation on tool arguments. Prefer explicit narrow validation before hitting the DB.

## Tool authoring pattern

```ts
// 1. ListToolsRequestSchema — declare with inputSchema JSON schema
// 2. CallToolRequestSchema — dispatch on name, validate args, do work, return content[]
// 3. Errors: return { content: [...], isError: true } — never throw uncaught
```

## Done-when checklist

- [ ] New tool listed in `docs/knowledge/api-reference.md`.
- [ ] Every mutation calls `syncJSONRegistry()`.
- [ ] Error responses set `isError: true`.
- [ ] Zod-validated arguments.
- [ ] `qa-reviewer` invoked.
