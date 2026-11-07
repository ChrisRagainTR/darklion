# DarkLion API Reference

This is the machine-readable API reference for agents and coding tools. It intentionally avoids client-side rendering.

## Base URL

```txt
https://your-darklion.example
```

## Authentication

Use a DarkLion API key generated in Settings → API Keys.

```http
Authorization: Bearer <dlk_api_key>
Content-Type: application/json
```

Agent Work API keys must be assigned to a staff/agent identity.

The remote MCP endpoint uses OAuth 2.1 instead of API keys. OAuth access tokens are
audience-bound to `https://your-darklion.example/mcp` and are not valid as general DarkLion
API credentials.

## Error format

```json
{ "error": "Human-readable error message" }
```

Common status codes: `400`, `401`, `403`, `404`, `429`, `500`.

---

# Agent Work API

Agent Work endpoints are under `/api/agent-work` and are designed for staff-scoped agents.

Use the live revenue forecast daily or when preparing a projection. The other polling endpoints can be checked more frequently for workflow activity.

The remote MCP exposes 62 narrow tools covering the supported business API
surface. It uses dedicated Agent Work adapters for firm/staff scope, explicit
response projections, capabilities, auditing, and bounded inputs. Duplicate route
variants are collapsed where one structured tool is clearer.

## Remote MCP and OAuth

- MCP endpoint: `https://your-darklion.example/mcp`
- Protected-resource metadata: `https://your-darklion.example/.well-known/oauth-protected-resource/mcp`
- Authorization-server metadata: `https://your-darklion.example/.well-known/oauth-authorization-server`
- OAuth flow: Authorization Code with mandatory S256 PKCE
- OAuth scopes: `darklion:read`, `darklion:write`, and `darklion:communicate`

Read tools require `darklion:read`. Internal mutations require `darklion:write`.
Attachment-free client send/reply requires the separate `darklion:communicate`
grant plus an idempotency nonce. OAuth tokens are bound to the
authorizing firm, active staff identity, client, granted scopes, and exact MCP
resource.

Existing MCP connections must reconnect and re-authorize to receive the new
communication grant and refreshed 62-tool catalog.

## GET `/api/agent-work/companies`

Requires capability: `transactions_read`.

Lists active companies visible to the scoped staff identity. Staff-level company
restrictions are enforced. Use the returned `id` or `realm_id` with transaction
search and backfill.

## GET `/api/agent-work/crm/search?q=Smith&limit=10`

Requires capability: `crm_read`.

Searches the authorized firm's relationship names, linked people, spouse names,
emails, and active companies. Results are returned in separate `relationships`,
`people`, and `companies` arrays. `q` is required and limited to 200 characters;
`limit` is optional, applies per entity type, and is capped at 25.

## GET `/api/agent-work/status`

Validate API authentication and return the scoped firm/staff identity, effective capabilities, and resource-specific notes for endpoints with side effects.

### Example

```bash
curl https://your-darklion.example/api/agent-work/status \
  -H "Authorization: Bearer <dlk_api_key>"
```

### Response

```json
{
  "ok": true,
  "firm_id": 1,
  "staff_user_id": 1,
  "agent_connection_id": null,
  "agent_name": "API Agent",
  "capabilities": {
    "agent_work": true,
    "inbox_read": true,
    "inbox_drafts": true,
    "team_chat_read": true,
    "team_chat_send": true,
    "documents_read": true,
    "activity_log_read": true,
    "transactions_read": true,
    "transactions_write": true,
    "revenue_read": true,
    "general_api": true,
    "summaries_read": true,
    "crm_read": true
  },
  "resources": {
    "summaries": {
      "calendar_read": true,
      "detail_read": true,
      "detail_marks_viewed": false
    },
    "revenue_forecast": {
      "read": true,
      "live_sources": true
    }
  }
}
```

`summaries_read` covers the Conversation Summaries calendar and detail endpoints. Both Agent Work adapter reads are side-effect free.

---

# Revenue Forecast

Requires capability: `revenue_read`.

## GET `/api/agent-work/revenue-forecast?year=2027`

Returns the same live recurring-revenue forecast used by DarkLion's Revenue Forecast page. Agents can use the summary totals, monthly aggregates, and customer-level monthly figures to predict future firm revenue. The calculation reads current Stripe subscriptions and invoices plus configured AUM billing; it does not mutate billing data.

`year` is optional and defaults to the current year. Supported years are 2000 through ten years after the current year.

### Example

```bash
curl "https://your-darklion.example/api/agent-work/revenue-forecast?year=2027" \
  -H "Authorization: Bearer <dlk_api_key>"
```

### Response

```json
{
  "generated_at": "2026-07-30T14:15:00.000Z",
  "year": 2027,
  "totals": {
    "annual": 312000,
    "collected": 0,
    "pastDue": 0,
    "upcoming": 312000
  },
  "monthly_totals": [
    {
      "month": "2027-01",
      "collected": 0,
      "past_due": 0,
      "upcoming": 26000,
      "projected": 26000
    }
  ],
  "customers": [
    {
      "custId": "cus_example",
      "name": "Example Client",
      "account": "default",
      "source": "stripe",
      "monthlyAmount": 1000,
      "annual": 12000,
      "collected": 0,
      "pastDue": 0,
      "upcoming": 12000,
      "months": [
        { "status": "upcoming", "amount": 1000 }
      ]
    }
  ],
  "assumptions": {
    "sources": [
      "stripe_active_subscriptions",
      "stripe_past_due_subscriptions",
      "aum_billing"
    ],
    "annual_definition": "Current monthly recurring amount multiplied by 12.",
    "projected_definition": "Paid, past-due, or upcoming recurring revenue assigned to each month.",
    "baseline_assumption": "Current recurring amounts continue unchanged; churn, growth, cancellations, and AUM market movement are not modeled.",
    "excludes": [
      "one_time_revenue",
      "unsigned_proposals",
      "non_recurring_qbo_revenue"
    ]
  }
}
```

Use `monthly_totals[].projected` as the recurring-revenue baseline for a month. Apply the assumptions explicitly when producing forecasts; the baseline does not itself model churn, growth, cancellations, AUM market movement, one-time revenue, or unsigned proposals.

---

# Transaction Search

Search a company's QBO transaction history stored in DarkLion. Searches both `transactions` and latest deduped `bookkeeper_uncoded` rows.

Requires capability: `transactions_read`.

## GET `/api/agent-work/companies/:companyId/transactions/search`

Best for simple/debuggable calls.

### Query parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `vendor` | string | Vendor/payee search. Also checks description, original account, doc number, and memo. Aliases: `payee`, `vendor_name`, `vendorName`. |
| `q` / `query` | string | General text search. Useful for `q=check 1023`. |
| `amount` | number | Exact absolute amount match. Defaults to ±$0.01 tolerance. |
| `amount_near` / `amountNear` | number | Fuzzy absolute amount match. Defaults to ±5% or ±$1, whichever is greater. |
| `tolerance` | number | Override exact/near amount tolerance. |
| `amount_min` / `amountMin` | number | Minimum absolute amount. |
| `amount_max` / `amountMax` | number | Maximum absolute amount. |
| `date_from` / `dateFrom` | date | YYYY-MM-DD lower transaction-date bound. |
| `date_to` / `dateTo` | date | YYYY-MM-DD upper transaction-date bound. |
| `status` | string | Filter by status, e.g. `categorized`, `pending`, `coded`; omit for all. |
| `type` / `txn_type` | string | Filter by transaction type. |
| `source` | string | `transactions`, `bookkeeper_uncoded`, or omit for both. |
| `include_uncoded` / `includeUncoded` | boolean | Default true. Set false to search only coded transaction history. |
| `limit` | number | Default 25, max 100. |
| `offset` | number | Pagination offset. |

### Example

```bash
curl "https://your-darklion.example/api/agent-work/companies/123/transactions/search?q=check%201023&amount_near=6221.11&tolerance=100&limit=10" \
  -H "Authorization: Bearer <dlk_api_key>"
```

## POST `/api/agent-work/transactions/search`

Best for agents that send structured JSON.

### Body

```json
{
  "company_id": 37,
  "q": "check 1023",
  "vendor": "rent",
  "amount": { "near": 6221.11, "tolerance": 100 },
  "date_range": {
    "from": "2024-01-01",
    "to": "2026-12-31"
  },
  "limit": 10,
  "offset": 0
}
```

`company_id` or `realm_id` is required.

Amount object supports:

```json
{ "exact": 129.99 }
```

or:

```json
{ "near": 130, "tolerance": 20 }
```

### Example

```bash
curl -X POST https://your-darklion.example/api/agent-work/transactions/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <dlk_api_key>" \
  -d '{
    "company_id": 123,
    "q": "check 1023",
    "amount": { "near": 6221.11, "tolerance": 100 },
    "limit": 10
  }'
```

### Response

```json
{
  "company": {
    "id": 123,
    "realm_id": "1234567890123456",
    "company_name": "Example Company"
  },
  "query": {
    "companyId": 37,
    "q": "check 1023",
    "amountNear": 6221.11,
    "tolerance": 100,
    "limit": 10,
    "offset": 0
  },
  "count": 1,
  "total_count": 1,
  "limit": 10,
  "offset": 0,
  "transactions": [
    {
      "id": 12345,
      "source": "transactions",
      "source_id": "12345",
      "transaction_id": "3178",
      "qb_id": "3178",
      "company_id": 123,
      "realm_id": "1234567890123456",
      "company_name": "Example Company",
      "date": "2025-04-12",
      "vendor": "Vendor Name",
      "vendor_name": "Vendor Name",
      "amount": 6221.11,
      "description": "Description text",
      "original_account": "Rent Expense",
      "coded_account": "Rent Expense",
      "coded_by": "qbo_backfill",
      "coded_at": "2026-05-13T10:22:00.000Z",
      "doc_number": "1023",
      "memo": "Memo text",
      "qbo_txn_type": "Purchase",
      "ai_category": "",
      "ai_confidence": null,
      "ai_memo": "",
      "txn_type": "Check",
      "status": "categorized",
      "run_id": null
    }
  ]
}
```

---

# Transaction Backfill

Pull historical QBO transactions into DarkLion's searchable transaction table.

Requires capability: `transactions_write`.

Backfill is safe to rerun. It upserts by `(realm_id, qb_id)`.

## POST `/api/agent-work/companies/:companyId/transactions/backfill`

### Body

```json
{
  "months": 24,
  "types": ["Purchase", "Bill", "Deposit"]
}
```

Fields:

| Field | Type | Description |
| --- | --- | --- |
| `months` | number | Lookback window. Default 24, max 84. |
| `types` | array | Optional QBO entity types. Defaults to Purchase, Bill, Deposit, SalesReceipt, Invoice, Payment, JournalEntry, CreditMemo, VendorCredit, RefundReceipt. |

### Example

```bash
curl -X POST https://your-darklion.example/api/agent-work/companies/123/transactions/backfill \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <dlk_api_key>" \
  -d '{"months":24}'
```

## POST `/api/agent-work/transactions/backfill`

JSON-body variant. Pass `company_id` or `realm_id`.

### Body

```json
{
  "company_id": 123,
  "months": 24
}
```

### Response

```json
{
  "ok": true,
  "company": {
    "id": 123,
    "realm_id": "1234567890123456",
    "company_name": "Example Company"
  },
  "start_date": "2024-05-13",
  "months": 24,
  "types": ["Purchase", "Bill", "Deposit"],
  "fetched": 1515,
  "inserted": 3,
  "updated": 1512,
  "errors": [],
  "by_type": {
    "Purchase": { "fetched": 100, "inserted": 10, "updated": 90 }
  }
}
```

---

# Inbox endpoints

Requires capability: `inbox_read` for reads and `inbox_drafts` for drafts.

## GET `/api/agent-work/inbox/summary`

Returns visible Inbox counts for the connected staff/agent identity.

## GET `/api/agent-work/inbox/threads?unread=true&limit=25`

Lists visible Inbox threads.

## GET `/api/agent-work/inbox/threads/:threadId`

Fetches thread profile, recent messages, and pending agent drafts. Read-only; does not mark messages read.

## POST `/api/agent-work/inbox/threads/:threadId/draft`

Creates a pending client reply draft for staff review. Does not send to the client.

Body:

```json
{
  "draft_body": "Suggested reply text",
  "confidence": 0.91,
  "notes": "Internal notes"
}
```

---

# Activity Log endpoint

Requires capability: `activity_log_read`.

## GET `/api/agent-work/activity-log?date=2026-06-19&include_summaries=true`

Returns a firm-wide, append-only activity feed for workflow-triggering events. The default date is today in `America/New_York`. Message summaries come from the cached daily conversation summary job and do not include raw transcripts.

### Query parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `date` | date | Eastern business date, `YYYY-MM-DD`. Ignored when `since`/`until` are used. |
| `since` | date-time | Lower `occurred_at` bound for cursor-style reads. |
| `until` | date-time | Upper `occurred_at` bound for cursor-style reads. |
| `event_type` | string | Repeatable or comma-separated event type filter. |
| `include_summaries` | boolean | Default true. Set false to return events only. |
| `limit` | number | Default 100, max 500. Summaries are not counted against the limit. |

### Example

```bash
curl "https://your-darklion.example/api/agent-work/activity-log?date=2026-06-19&event_type=organizer_submitted&include_summaries=true" \
  -H "Authorization: Bearer <dlk_api_key>"
```

### Response

```json
{
  "date": "2026-06-19",
  "events": [
    {
      "id": 101,
      "event_type": "organizer_submitted",
      "title": "2025 tax organizer submitted",
      "summary": "Jane Smith submitted the 2025 tax organizer.",
      "occurred_at": "2026-06-19T22:10:00.000Z",
      "event_date": "2026-06-19",
      "person_id": 42,
      "company_id": null,
      "tax_year": "2025",
      "entity_type": "person",
      "entity_id": 42,
      "source_table": "tax_organizers",
      "source_id": "9",
      "metadata": {
        "organizer_id": 9,
        "workpaper_document_id": 812
      }
    }
  ],
  "message_summaries": {
    "generated_at": "2026-06-20T02:00:00.000Z",
    "client_threads": [],
    "team_chats": []
  },
  "generated_at": "2026-06-20T02:05:00.000Z"
}
```

---

# Team Chat endpoints

Requires capability: `team_chat_read` for reads and `team_chat_send` for replies.

## GET `/api/agent-work/team-chat/summary`

Returns unread Team Chat counts.

## GET `/api/agent-work/team-chat/conversations?unread=true&limit=50`

Lists visible Team Chat conversations.

## GET `/api/agent-work/team-chat/conversations/:conversationId/messages`

Fetches recent messages and attachment metadata. Read-only; does not mark the conversation read.

## POST `/api/agent-work/team-chat/conversations/:conversationId/reply`

Sends an internal Team Chat reply as the connected staff user.

Body:

```json
{
  "body": "Message text",
  "client_nonce": "optional-idempotency-key"
}
```

---

# Company discovery

Use `GET /api/agent-work/companies` to discover the companies visible to the
authenticated staff user before calling a company-scoped endpoint.
