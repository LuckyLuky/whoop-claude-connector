import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  consumeAuthorizationCode,
  lookupAccessToken,
  rotateRefreshToken,
  takeOne,
} from './store.ts';
import { hashToken } from '../crypto.ts';

/**
 * Two failure modes live here, and both are expensive.
 *
 * A read that fails is not a row that is missing: `null` travels to /token as
 * `invalid_grant`, which Claude reads as "this refresh token is dead" and
 * answers by discarding a working one. A Supabase blip must not do that.
 *
 * And a code or refresh token is single-use, so the row has to be consumed by
 * the statement that hands it out. Selecting and then deleting leaves a window
 * where two callers both believe they won. The fake below mirrors the one
 * semantic that fix leans on: `delete(...).select()` returns rows to whichever
 * statement actually removed them, and nothing to the one that came second.
 */

type Row = Record<string, unknown>;

interface FakeDb {
  client: SupabaseClient;
  tables: Record<string, Row[]>;
  calls: string[];
}

function createFakeDb(
  tables: Record<string, Row[]>,
  options: { failReads?: boolean } = {},
): FakeDb {
  const calls: string[] = [];
  const rowsIn = (name: string) => (tables[name] ??= []);

  const readError = { message: 'connection reset by peer' };

  const client = {
    from(name: string) {
      return {
        select() {
          return {
            eq(column: string, value: unknown) {
              return {
                async maybeSingle() {
                  calls.push(`select ${name}`);
                  if (options.failReads) return { data: null, error: readError };
                  const row = rowsIn(name).find((r) => r[column] === value) ?? null;
                  return { data: row, error: null };
                },
              };
            },
          };
        },
        insert(row: Row) {
          calls.push(`insert ${name}`);
          rowsIn(name).push(row);
          return Promise.resolve({ error: null });
        },
        delete() {
          return {
            eq(column: string, value: unknown) {
              const run = () => {
                calls.push(`delete ${name}`);
                if (options.failReads) return { removed: null, error: readError };
                const rows = rowsIn(name);
                const index = rows.findIndex((r) => r[column] === value);
                // Only the statement that removed the row sees it.
                const removed = index >= 0 ? rows.splice(index, 1)[0] : null;
                return { removed, error: null };
              };
              return {
                select() {
                  return {
                    async maybeSingle() {
                      const { removed, error } = run();
                      return { data: removed, error };
                    },
                  };
                },
                then(onFulfilled: (value: { error: unknown }) => unknown) {
                  const { error } = run();
                  return Promise.resolve({ error }).then(onFulfilled);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, tables, calls };
}

const LATER = new Date(Date.now() + 600_000).toISOString();
const EARLIER = new Date(Date.now() - 600_000).toISOString();

function codeRow(over: Row = {}): Row {
  return {
    code: 'code-1',
    client_id: 'https://claude.ai/client',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
    whoop_token_id: 'grant-1',
    scope: 'whoop',
    expires_at: LATER,
    ...over,
  };
}

function tokenRow(over: Row = {}): Row {
  return {
    token_hash: hashToken('access-1'),
    refresh_token_hash: hashToken('refresh-1'),
    client_id: 'https://claude.ai/client',
    whoop_token_id: 'grant-1',
    scope: 'whoop',
    expires_at: LATER,
    refresh_expires_at: LATER,
    ...over,
  };
}

describe('takeOne', () => {
  it('throws when the query failed, so the caller cannot mistake it for a miss', () => {
    assert.throws(
      () => takeOne({ data: null, error: { message: 'connection reset' } }, 'access token'),
      /Failed to read access token: connection reset/,
    );
  });

  it('returns null when the query succeeded and matched nothing', () => {
    assert.equal(takeOne({ data: null, error: null }, 'access token'), null);
  });

  it('returns the row when there is one', () => {
    const row = { token_hash: 'abc' };
    assert.equal(takeOne({ data: row, error: null }, 'access token'), row);
  });
});

describe('lookupAccessToken', () => {
  it('throws rather than reporting an unknown token when the read fails', async () => {
    const { client } = createFakeDb({ mcp_access_tokens: [tokenRow()] }, { failReads: true });

    await assert.rejects(() => lookupAccessToken('access-1', client), /Failed to read/);
  });

  it('returns null for an expired token', async () => {
    const { client } = createFakeDb({
      mcp_access_tokens: [tokenRow({ expires_at: EARLIER })],
    });

    assert.equal(await lookupAccessToken('access-1', client), null);
  });

  it('returns the record for a live token', async () => {
    const { client } = createFakeDb({ mcp_access_tokens: [tokenRow()] });

    const record = await lookupAccessToken('access-1', client);

    assert.equal(record?.whoop_token_id, 'grant-1');
  });
});

describe('consumeAuthorizationCode', () => {
  it('hands the code to exactly one of two concurrent redemptions', async () => {
    const { client } = createFakeDb({ mcp_authorization_codes: [codeRow()] });

    const results = await Promise.all([
      consumeAuthorizationCode('code-1', client),
      consumeAuthorizationCode('code-1', client),
    ]);

    const winners = results.filter((r) => r !== null);
    assert.equal(winners.length, 1);
    assert.equal(winners[0]?.whoop_token_id, 'grant-1');
  });

  it('throws when the statement fails instead of reporting an unknown code', async () => {
    const { client } = createFakeDb(
      { mcp_authorization_codes: [codeRow()] },
      { failReads: true },
    );

    await assert.rejects(() => consumeAuthorizationCode('code-1', client), /Failed to/);
  });

  it('returns null for an expired code, and still consumes the row', async () => {
    const { client, tables } = createFakeDb({
      mcp_authorization_codes: [codeRow({ expires_at: EARLIER })],
    });

    assert.equal(await consumeAuthorizationCode('code-1', client), null);
    assert.equal(tables.mcp_authorization_codes.length, 0);
  });
});

describe('rotateRefreshToken', () => {
  it('throws rather than answering invalid_grant when the read fails', async () => {
    const { client } = createFakeDb({ mcp_access_tokens: [tokenRow()] }, { failReads: true });

    await assert.rejects(() => rotateRefreshToken('refresh-1', client), /Failed to read/);
  });

  it('issues a replacement and consumes the old row', async () => {
    const { client, tables } = createFakeDb({ mcp_access_tokens: [tokenRow()] });

    const rotated = await rotateRefreshToken('refresh-1', client);

    assert.equal(rotated?.clientId, 'https://claude.ai/client');
    assert.equal(tables.mcp_access_tokens.length, 1);
    assert.equal(
      tables.mcp_access_tokens[0].token_hash,
      hashToken(rotated!.tokens.accessToken),
    );
  });

  it('lets one of two concurrent rotations win and leaves no orphan tokens', async () => {
    const { client, tables } = createFakeDb({ mcp_access_tokens: [tokenRow()] });

    const results = await Promise.all([
      rotateRefreshToken('refresh-1', client),
      rotateRefreshToken('refresh-1', client),
    ]);

    const winners = results.filter((r) => r !== null);
    assert.equal(winners.length, 1);
    // The loser must clean up the pair it issued before losing the race.
    assert.equal(tables.mcp_access_tokens.length, 1);
    assert.equal(
      tables.mcp_access_tokens[0].token_hash,
      hashToken(winners[0]!.tokens.accessToken),
    );
  });

  it('returns null for an expired refresh token without issuing anything', async () => {
    const { client, tables } = createFakeDb({
      mcp_access_tokens: [tokenRow({ refresh_expires_at: EARLIER })],
    });

    assert.equal(await rotateRefreshToken('refresh-1', client), null);
    assert.equal(tables.mcp_access_tokens.length, 0);
  });
});
