@AGENTS.md

# WHOOP → Claude connector

Personal, single-user remote MCP server exposing WHOOP data to Claude.
Next.js (App Router) on Vercel, Supabase for storage. See README.md for setup.

## Shape of the thing

This app is two servers wearing one coat:

1. **An OAuth authorization server** that Claude talks to. It exists only
   because WHOOP's OAuth server supports neither Dynamic Client Registration
   nor RFC 8414 discovery, which is what Claude needs to configure itself.
2. **An MCP server** exposing six read-only WHOOP tools.

The bridge is the interesting part. `/authorize` parks Claude's PKCE request
and redirects to WHOOP; `/callback` exchanges WHOOP's code using the
confidential client secret, stores the WHOOP tokens encrypted, then mints our
*own* authorization code for Claude; `/token` trades that for an opaque bearer
which is a lookup key into the stored WHOOP grant.

## Layout

```
app/api/mcp/route.ts          MCP endpoint + the 401 auth gate
app/api/oauth/*               authorize / callback / token / register
app/api/well-known/*          RFC 9728 + RFC 8414 discovery documents
app/api/webhooks/whoop        signature-verified webhook receiver (no-op)
lib/mcp/server.ts             tool definitions
lib/oauth/*                   client resolution (CIMD + DCR), PKCE, storage
lib/whoop/*                   WHOOP OAuth, token refresh, API client, normalizers
lib/dates.ts                  local-day → UTC window translation
supabase/migrations/          schema
next.config.ts                rewrites that expose /.well-known/*, /mcp, /token …
```

Public paths (`/mcp`, `/token`, `/.well-known/…`) are **rewrites** onto
`app/api/**`. Next.js handles dot-prefixed directories in `app/`
inconsistently, and the discovery documents have to sit at the origin root.
Add a route under `app/api/` and map it in `next.config.ts`.

## Things that will bite you

- **The auth gate must produce a transport-level `401`.** A `200` wrapping
  `isError: true` is read by the model as a failed tool call and Claude never
  shows a Connect card. The gate lives in `app/api/mcp/route.ts` and runs
  *before* the JSON-RPC body reaches the SDK, because once a tool handler is
  running its return value is already destined for a `200`.
- **Never return `invalid_grant` for an infrastructure failure.** Claude reads
  it as "this refresh token is dead" and discards a working one. Use
  `server_error`.
- **WHOOP rotates refresh tokens on every refresh.** Persist the new one or the
  grant dies.
- **The `offline` scope is what makes refresh tokens exist.** Drop it and the
  connector stops working an hour after each sign-in.
- **`/token` must accept `application/x-www-form-urlencoded`.** `/register`
  uses JSON. They are different parsers by spec.
- Tools are stateless per request — a fresh `McpServer` is built per call, so
  nothing may be cached on the instance.

## Checks

```bash
npx tsc --noEmit
npm run build
npm run lint
npm test
```

`npm test` is `node --test`: Node runs the `.ts` files directly, so there is no
test framework and no build step. Two consequences for any file reachable from
a test — `lib/dates.ts`, `lib/html.ts`, `lib/crypto.ts`, `lib/oauth/*`,
`lib/whoop/*`:

- **Relative imports need the `.ts` extension.** Node resolves ESM literally;
  the bundler is fine either way.
- **No parameter properties** (`constructor(private readonly x: T)`). Node
  strips types, it does not compile them. Declare the field and assign it.

`lib/oauth/store.ts` takes an optional `SupabaseClient` on the functions that
consume a single row, so the delete-and-return semantics those rely on can be
tested against a fake. `takeOne()` is why a failed query never looks like a
missing row.

`lib/whoop/tokens.ts` splits the refresh *policy* from storage
(`grant-store.ts`) so the lease and rotation can be tested against an in-memory
store; `createTokenService()` takes the seams, and the module's named exports
are the production instance.

A date test that still passes when you break `lib/dates.ts` is not a test:
single-pass offset lookups only go wrong in far-east zones, which is why
`Pacific/Auckland` is in there.
