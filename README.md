# WHOOP → Claude connector

A personal remote MCP server that gives Claude read-only access to your WHOOP
data: recovery, sleep, day strain, workouts and body measurements.

Built as a Next.js app on Vercel with Supabase for token storage. Single-user
by design — this is not a directory-listed connector.

---

## Why there is an OAuth server in here

WHOOP's OAuth server doesn't support Dynamic Client Registration and doesn't
publish RFC 8414 discovery metadata — apps are registered by hand in the WHOOP
developer dashboard. Claude, on the other hand, discovers an authorization
server from the MCP server's own origin and registers itself dynamically.

So this app **bridges the two**: it is a small OAuth authorization server in its
own right, and brokers the real exchange with WHOOP behind it.

```
Claude  ──/authorize──▶  this app  ──▶  WHOOP consent screen
                              ◀── /callback (WHOOP auth code)
                              │    exchanges it with the WHOOP client secret,
                              │    stores WHOOP tokens encrypted in Supabase
Claude  ◀── our own auth code ─┘
Claude  ──/token──────▶  this app  ──▶  our own opaque bearer token
Claude  ──/mcp────────▶  this app  ──▶  WHOOP API v2 (using the stored tokens)
```

The WHOOP client secret and the raw WHOOP tokens never leave the server.
Claude only ever holds a bearer token that this app issued, which is a lookup
key into a row we can revoke at any time.

---

## Endpoints

| Path | Purpose |
|---|---|
| `POST /mcp` | The MCP endpoint. **This is the URL you paste into Claude.** |
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728 protected resource metadata |
| `GET /.well-known/oauth-authorization-server[/mcp]` | RFC 8414 authorization server metadata |
| `POST /register` | RFC 7591 Dynamic Client Registration (fallback when a client can't use CIMD) |
| `GET /authorize` | Start of the bridged authorization flow |
| `GET /callback` | WHOOP's redirect target — register this in the WHOOP dashboard |
| `POST /token` | Token exchange and refresh |
| `POST /api/webhooks/whoop` | Optional WHOOP webhook receiver (signature-verified, currently a no-op) |
| `GET /` | Status page — shows which env vars are set, never their values |

`initialize` and `tools/list` work without authentication, so Claude can connect
and inspect the server before you sign in. The first `tools/call` returns
`401` with a `WWW-Authenticate` header, which is what makes Claude show an
inline **Connect** card instead of a failed tool call.

---

## Tools

| Tool | What it returns |
|---|---|
| `get_daily_summary` | One day's cycle, recovery and sleep in a single call. Start here. |
| `get_recovery` | Recovery %, resting HR, HRV (RMSSD), SpO2, skin temperature |
| `get_sleep` | Time in bed, light/deep/REM split, performance, efficiency, sleep debt |
| `get_strain` | Day strain (0–21), calories, average/max HR |
| `get_workouts` | Sport, duration, strain, HR zones, distance, elevation |
| `get_profile` | Name, email, height, weight, max HR |

All are marked `readOnlyHint` — nothing here writes to WHOOP. Responses are
normalized: durations in minutes, energy in kilocalories, distances in meters,
and WHOOP's nested `score` objects flattened.

Date arguments accept `date` (`YYYY-MM-DD`, resolved in `WHOOP_TIMEZONE`),
explicit `start`/`end` ISO-8601 instants, or `days` to look back from now.
Pagination is handled internally, so a tool returns the whole range rather than
WHOOP's first page of ten.

---

## Setup

### 1. WHOOP app

You need an active WHOOP membership to use the developer platform at all.

1. Create a team and an app at <https://developer-dashboard.whoop.com>.
2. Enable scopes: `read:cycles`, `read:sleep`, `read:recovery`, `read:workout`,
   `read:profile`, `read:body_measurement`, and **`offline`** — without
   `offline` WHOOP issues no refresh token and the connector dies after an hour.
3. Register the redirect URI: `https://<your-domain>/callback`
4. Copy the Client ID and Client Secret.

### 2. Supabase

Run the migration in `supabase/migrations/0001_init.sql` against your project
(paste it into the SQL editor, or `supabase db push`). It creates five tables,
enables RLS with no policies — so only the service role key can read them — and
adds a `prune_expired_oauth_rows()` housekeeping function.

### 3. Environment

Copy `.env.example` to `.env.local` and fill it in:

```bash
cp .env.example .env.local
openssl rand -base64 32   # -> TOKEN_ENCRYPTION_KEY
```

`APP_BASE_URL` must be the public HTTPS origin with no trailing slash, and must
match what you type into Claude. Set the same variables in the Vercel project.

`ALLOWED_WHOOP_USER_ID` locks the connector to your WHOOP account. You don't
need to know it up front: leave it empty, connect once, and the sign-in page
refuses the account and shows the id to set. Redeploy and connect again.

### 4. Deploy

```bash
npm install
npm run build
vercel deploy --prod
```

Claude reaches connectors from Anthropic's infrastructure, so `localhost` will
not work. For local development, expose the dev server with a tunnel and set
`APP_BASE_URL` to the tunnel URL:

```bash
npm run dev
cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
```

### 5. Add to Claude

**Customize → Connectors → Add custom connector**, and enter:

```
https://<your-domain>/mcp
```

Leave the OAuth fields blank — the server advertises both CIMD and Dynamic
Client Registration, so Claude configures itself. On the first tool call you
get a Connect card, which takes you to WHOOP's consent screen.

---

## Verifying it works

```bash
BASE=https://<your-domain>

# Discovery
curl -s $BASE/.well-known/oauth-protected-resource/mcp | jq
curl -s $BASE/.well-known/oauth-authorization-server | jq

# tools/list works unauthenticated
curl -s $BASE/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '.result.tools[].name'

# A protected call returns 401 + WWW-Authenticate (this is correct)
curl -si $BASE/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_profile","arguments":{}}}' \
  | grep -i www-authenticate
```

---

## Operational notes

- **WHOOP rotates refresh tokens.** Every refresh returns a new one and
  invalidates the old. `lib/whoop/tokens.ts` persists the replacement before
  handing out the new access token.
- **WHOOP access tokens last 3600s.** They're refreshed 120s ahead of expiry,
  and a `401` from the API forces one retry with a fresh token.
- **Rate limits** are 100 req/min and 10,000 req/day per app. A `429` surfaces
  as a tool error naming the reset window rather than being retried in a loop.
- **Codes only go to Claude.** `/authorize` and `/register` accept only
  `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`
  and loopback redirect URIs. Open registration plus arbitrary redirect URIs
  would let anyone phish a code for your data through WHOOP's real consent
  screen.
- **Infrastructure failures are never reported as `invalid_grant`.** Claude
  treats that code as "this refresh token is dead" and would discard a working
  one, forcing a needless reconnect. `/token` returns `server_error` instead.
- **Revoking access:** delete the row from `whoop_tokens` (tokens cascade), and
  call `DELETE /v2/user/access` on the WHOOP API to drop the grant upstream.
- **Housekeeping:** schedule `select prune_expired_oauth_rows();` (pg_cron or a
  Vercel cron job) to clear expired codes and tokens.

## Not built yet

- Webhook fan-out. `app/api/webhooks/whoop/route.ts` verifies signatures and
  logs; it doesn't persist anything. Wire it to a cache table if you want a
  warm local copy or a scheduled digest.
- Derived trend tools (rolling 7/30-day recovery and strain averages).
- Automated tests. The date-window logic in `lib/dates.ts` and the token
  rotation in `lib/whoop/tokens.ts` are the two places worth covering first.
