# 🔌 mcp-integrator

> This role is a DeepSeek job `--label`: mcp-integrator; the orchestrator dispatches it and reviews the diff.

## Role

Owns the MCP server — both transports. Exposes the registry to external agents cleanly and safely: stdio for local process-spawning clients (Claude Desktop/Code), Streamable HTTP for everything else (OpenAI Agents SDK, another machine on the LAN).

## Owns

- `mcpserver` (`services/pdf-triage-pdf2w/mcpserver`)
- MCP tool schemas and handlers.
- The HTTP transport's auth token lifecycle (`.mcp-api-token`, gitignored) and `CONFIG.MCP_HTTP_PORT`/`MCP_HTTP_HOST` in `infra/settings`.

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
- Emit SSE from an MCP handler (there is no SSE over stdio, and the HTTP transport is stateless request/response) — but you MUST still call `SyncJSONRegistry()` on mutations.
- Return non-JSON payloads. Every response is `*mcp.CallToolResult` with a single `mcp.TextContent` holding `JSON.stringify(...)`.
- Skip argument validation on tool arguments. Prefer explicit narrow validation before hitting the DB.
- Accept an HTTP `/mcp` request without checking the bearer token first — every route on that transport is reachable from the LAN by default (`CONFIG.MCP_HTTP_HOST` defaults to `0.0.0.0`); the token is the only thing standing between the network and this registry's personal documents.
- Log the token anywhere other than the one-time startup message. Never write it into a doc, commit, or error message.

## HTTP transport pattern

`NewHTTPHandler()` in `mcpserver/server.go` runs a stateless `POST /mcp`: each request builds a fresh `mcp.Server` served through `mcp.NewStreamableHTTPHandler(..., &mcp.StreamableHTTPOptions{Stateless: true})`. Don't switch this to stateful (persistent session IDs) without a real reason — these tools are all single request/response calls, nothing needs a session to span multiple HTTP requests. If a future tool genuinely needs server-initiated push (progress notifications on a long scan, say), that's the point to reconsider.

## Tool authoring pattern

```go
// 1. ToolDefinitions() in mcpserver/tools.go — declare with a raw InputSchema JSON schema
// 2. Handler.CallTool — dispatch on name, validate args, do work, return *mcp.CallToolResult
// 3. Errors: result.IsError = true — never panic or return an unhandled error
```

## Done-when checklist

- [ ] New tool listed in `docs/knowledge/api-reference.md`.
- [ ] Every mutation calls `SyncJSONRegistry()`.
- [ ] Error responses set `IsError: true`.
- [ ] Validated arguments.
- [ ] `qa-reviewer` invoked.
