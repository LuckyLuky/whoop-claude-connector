-- WHOOP → Claude connector schema.
--
-- Two groups of tables:
--   whoop_*  — the upstream grant (WHOOP access + refresh tokens, encrypted)
--   mcp_*    — the bridge authorization server Claude talks to
--
-- Everything here is written exclusively by the service role. RLS is enabled
-- with no policies at all, which denies every anon/authenticated request.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Upstream WHOOP grant
-- ---------------------------------------------------------------------------
create table if not exists whoop_tokens (
  id                uuid primary key default gen_random_uuid(),
  whoop_user_id     text        not null unique,
  -- AES-256-GCM ciphertext, base64(iv | tag | ciphertext). See lib/crypto.ts.
  access_token_enc  text        not null,
  refresh_token_enc text        not null,
  scope             text,
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- OAuth clients registered via RFC 7591 Dynamic Client Registration.
-- Clients using a Client ID Metadata Document never appear here.
-- ---------------------------------------------------------------------------
create table if not exists mcp_oauth_clients (
  client_id     text primary key,
  client_name   text,
  redirect_uris jsonb       not null,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- In-flight authorizations: the leg between Claude's /authorize call and
-- WHOOP's redirect back to /callback. Keyed by the state we send WHOOP.
-- ---------------------------------------------------------------------------
create table if not exists mcp_pending_authorizations (
  state                 text primary key,
  client_id             text        not null,
  client_redirect_uri   text        not null,
  client_state          text,
  code_challenge        text        not null,
  code_challenge_method text        not null,
  scope                 text,
  resource              text,
  expires_at            timestamptz not null,
  created_at            timestamptz not null default now()
);

create index if not exists mcp_pending_authorizations_expires_at_idx
  on mcp_pending_authorizations (expires_at);

-- ---------------------------------------------------------------------------
-- Authorization codes we issue to Claude. Single use, 10 minute TTL.
-- ---------------------------------------------------------------------------
create table if not exists mcp_authorization_codes (
  code                  text primary key,
  client_id             text        not null,
  redirect_uri          text        not null,
  code_challenge        text        not null,
  code_challenge_method text        not null,
  whoop_token_id        uuid        not null references whoop_tokens(id) on delete cascade,
  scope                 text,
  expires_at            timestamptz not null,
  created_at            timestamptz not null default now()
);

create index if not exists mcp_authorization_codes_expires_at_idx
  on mcp_authorization_codes (expires_at);

-- ---------------------------------------------------------------------------
-- Bearer + refresh tokens we issue to Claude.
-- Stored as SHA-256 digests: a database disclosure yields no usable credential.
-- ---------------------------------------------------------------------------
create table if not exists mcp_access_tokens (
  token_hash         text primary key,
  refresh_token_hash text unique,
  client_id          text        not null,
  whoop_token_id     uuid        not null references whoop_tokens(id) on delete cascade,
  scope              text,
  expires_at         timestamptz not null,
  refresh_expires_at timestamptz not null,
  created_at         timestamptz not null default now()
);

create index if not exists mcp_access_tokens_whoop_token_id_idx
  on mcp_access_tokens (whoop_token_id);
create index if not exists mcp_access_tokens_expires_at_idx
  on mcp_access_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- Lock everything down. No policies are defined, so only the service role key
-- (which bypasses RLS) can touch these tables.
-- ---------------------------------------------------------------------------
alter table whoop_tokens                enable row level security;
alter table mcp_oauth_clients           enable row level security;
alter table mcp_pending_authorizations  enable row level security;
alter table mcp_authorization_codes     enable row level security;
alter table mcp_access_tokens           enable row level security;

-- ---------------------------------------------------------------------------
-- Housekeeping. Call periodically (pg_cron, or a Vercel cron hitting a route)
-- to drop expired short-lived rows.
-- ---------------------------------------------------------------------------
create or replace function prune_expired_oauth_rows()
returns void
language sql
security definer
set search_path = public
as $$
  delete from mcp_pending_authorizations where expires_at < now();
  delete from mcp_authorization_codes     where expires_at < now();
  delete from mcp_access_tokens           where refresh_expires_at < now();
$$;
