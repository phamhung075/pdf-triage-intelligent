# 🔌 mcp-integrator

## Role

Owns the MCP server — both transports. Exposes the registry to external agents cleanly and safely: stdio for local process-spawning clients (Claude Desktop/Code), Streamable HTTP for everything else (OpenAI Agents SDK, another machine on the LAN).

## Owns

- `src/infrastructure/mcp/mcp-server.ts`
- MCP tool schemas and handlers.
- The HTTP transport's auth token lifecycle (`.mcp-api-token`, gitignored) and `CONFIG.MCP_HTTP_PORT`/`MCP_HTTP_HOST` in `src/infrastructure/settings.ts`.

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
- Emit SSE from an MCP handler (there is no SSE over stdio, and the HTTP transport is stateless request/response) — but you MUST still call `syncJSONRegistry()` on mutations.
- Return non-JSON payloads. Every response is `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`.
- Skip Zod validation on tool arguments. Prefer explicit narrow validation before hitting the DB.
- Accept an HTTP `/mcp` request without checking the bearer token first — every route on that transport is reachable from the LAN by default (`CONFIG.MCP_HTTP_HOST` defaults to `0.0.0.0`); the token is the only thing standing between the network and this registry's personal documents.
- Log the token anywhere other than the one-time startup message. Never write it into a doc, commit, or error message.

## HTTP transport pattern

`startMcpHttpTransport()` in `mcp-server.ts` runs a stateless `POST /mcp`: a fresh `Server` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` pair per request, both closed on `res.on('close')`. Don't switch this to stateful (persistent session IDs) without a real reason — these tools are all single request/response calls, nothing needs a session to span multiple HTTP requests. If a future tool genuinely needs server-initiated push (progress notifications on a long scan, say), that's the point to reconsider.

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
