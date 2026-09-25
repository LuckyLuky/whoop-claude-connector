import { decrypt, encrypt } from '../crypto.ts';
import { db } from '../supabase.ts';

/**
 * Persistence for the WHOOP grant, kept separate from the refresh policy in
 * tokens.ts so that policy can be tested without a database.
 *
 * Tokens cross this boundary in plaintext: encryption is a storage concern and
 * lives in the Supabase implementation below.
 */

export interface GrantRecord {
  id: string;
  whoopUserId: string;
  accessToken: string;
  refreshToken: string;
  /** ISO-8601 instant at which the access token expires. */
  expiresAt: string;
  scope: string | null;
}

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string | null;
}

export interface GrantStore {
  load(id: string): Promise<GrantRecord | null>;

  /** Upserts on the WHOOP user id and returns the grant id. */
  save(grant: Omit<GrantRecord, 'id'>): Promise<string>;

  /**
   * Takes the refresh lease, or reports that someone else holds it.
   *
   * Must be atomic: of several callers racing on the same grant, exactly one
   * gets `true`. A lease whose `until` has passed is free to take — its holder
   * died mid-refresh.
   */
  acquireLease(id: string, until: string, now: string): Promise<boolean>;

  releaseLease(id: string): Promise<void>;

  /** Stores refreshed tokens and frees the lease in one write. */
  storeRefreshed(id: string, tokens: RefreshedTokens): Promise<void>;

  delete(id: string): Promise<void>;
}

interface GrantRow {
  id: string;
  whoop_user_id: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: string;
  scope: string | null;
}

export const supabaseGrantStore: GrantStore = {
  async load(id) {
    const { data, error } = await db()
      .from('whoop_tokens')
      .select('id, whoop_user_id, access_token_enc, refresh_token_enc, expires_at, scope')
      .eq('id', id)
      .maybeSingle();

    if (error) throw new Error(`Failed to load WHOOP grant: ${error.message}`);
    if (!data) return null;

    const row = data as GrantRow;
    return {
      id: row.id,
      whoopUserId: row.whoop_user_id,
      accessToken: decrypt(row.access_token_enc),
      refreshToken: decrypt(row.refresh_token_enc),
      expiresAt: row.expires_at,
      scope: row.scope,
    };
  },

  async save(grant) {
    const { data, error } = await db()
      .from('whoop_tokens')
      .upsert(
        {
          whoop_user_id: grant.whoopUserId,
          access_token_enc: encrypt(grant.accessToken),
          refresh_token_enc: encrypt(grant.refreshToken),
          expires_at: grant.expiresAt,
          scope: grant.scope,
          refresh_lease_until: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'whoop_user_id' },
      )
      .select('id')
      .single();

    if (error) throw new Error(`Failed to persist WHOOP grant: ${error.message}`);
    return data.id as string;
  },

  /**
   * One conditional UPDATE. Postgres re-evaluates the WHERE clause against the
   * committed row version, so a second caller racing on the same grant matches
   * nothing and gets no row back.
   */
  async acquireLease(id, until, now) {
    const { data, error } = await db()
      .from('whoop_tokens')
      .update({ refresh_lease_until: until })
      .eq('id', id)
      // Timestamps carry ':' and '.', which need quoting inside or().
      .or(`refresh_lease_until.is.null,refresh_lease_until.lt."${now}"`)
      .select('id');

    if (error) throw new Error(`Failed to take WHOOP refresh lease: ${error.message}`);
    return data.length > 0;
  },

  async releaseLease(id) {
    await db()
      .from('whoop_tokens')
      .update({ refresh_lease_until: null })
      .eq('id', id);
  },

  async storeRefreshed(id, tokens) {
    const { error } = await db()
      .from('whoop_tokens')
      .update({
        access_token_enc: encrypt(tokens.accessToken),
        refresh_token_enc: encrypt(tokens.refreshToken),
        expires_at: tokens.expiresAt,
        scope: tokens.scope,
        refresh_lease_until: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to persist refreshed WHOOP token: ${error.message}`);
    }
  },

  async delete(id) {
    const { error } = await db().from('whoop_tokens').delete().eq('id', id);
    if (error) throw new Error(`Failed to delete WHOOP grant: ${error.message}`);
  },
};
