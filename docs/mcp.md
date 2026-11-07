# DarkLion MCP Server

DarkLion exposes its Agent Work API through a remote, staff-scoped MCP server.

## Connection

- Endpoint: `https://your-darklion.example/mcp`
- Transport: Streamable HTTP
- Authorization: OAuth 2.1 Authorization Code with mandatory S256 PKCE
- Scopes: `darklion:read`, `darklion:write`, and `darklion:communicate`

OAuth discovery is published at:

- `https://your-darklion.example/.well-known/oauth-protected-resource/mcp`
- `https://your-darklion.example/.well-known/oauth-authorization-server`

Authorization binds opaque credentials to the exact MCP resource, OAuth client,
DarkLion firm, active staff identity, and granted scopes. OAuth credentials are
not DarkLion API keys and cannot be used with the general API.

## Tools

The server exposes 62 narrow tools:

- Discovery and CRM: status, company listing, unified CRM search, relationship list/detail/snapshot/create/update, people list/detail/create/update/move, and company detail/create/update/move.
- Documents: list, folder list/create, metadata detail/update, extracted data, signed download URL, recoverable trash, and restore.
- Work: pipeline job list/update/move, stage list, active staff list, and the authenticated staff member's assigned work.
- Communications: conversation summary list/detail, Inbox summary/thread list/detail/draft, Team Chat summary/conversation/messages/reply, and attachment-free client send/reply.
- Business records: bookkeeping overview/runs/mappings, tax delivery list/detail/summary, organizer list/detail, proposal list/detail/stats, billing configuration, person investments, and engagement letters.
- Operations: activity log, revenue forecast, transaction search, and transaction backfill.

Read tools require `darklion:read`. Supported internal writes require
`darklion:write`. External client send/reply is deliberately isolated behind
`darklion:communicate`, requires an idempotency nonce, allows no attachments,
and preserves staff visibility and audit controls. Existing connections must be
re-authorized before communication tools can be used.

The machine-readable inclusion/exclusion decisions and security boundaries are
recorded in `docs/mcp-business-domain-catalog.json`. Authentication internals,
webhooks/callbacks, UI helpers, provider connection administration, broad
third-party syncs, AI generation, QBO posting, bulk mutations, and irreversible
deletes are intentionally not MCP tools.
