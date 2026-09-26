import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClient } from './clients.ts';

/**
 * A CIMD `client_id` is a URL chosen by whoever calls /authorize, so the
 * document behind it is hostile input. Anything this function throws surfaces
 * on the sign-in page, carrying the parser's message — which quotes the
 * response body — with it.
 */

const realFetch = globalThis.fetch;

function respondWith(body: string, init: ResponseInit = {}) {
  globalThis.fetch = async () =>
    new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('resolveClient over CIMD', () => {
  it('returns null when the document is not JSON at all', async () => {
    respondWith('<html><script>alert(1)</script></html>');

    assert.equal(await resolveClient('https://client.example/metadata'), null);
  });

  it('returns null when the document is truncated JSON', async () => {
    respondWith('{"client_id": "https://client.example/metadata"');

    assert.equal(await resolveClient('https://client.example/metadata'), null);
  });

  it('resolves a well-formed self-referential document', async () => {
    const clientId = 'https://client.example/metadata';
    respondWith(
      JSON.stringify({
        client_id: clientId,
        client_name: 'Example',
        redirect_uris: ['https://client.example/callback'],
      }),
    );

    assert.deepEqual(await resolveClient(clientId), {
      clientId,
      redirectUris: ['https://client.example/callback'],
      clientName: 'Example',
      source: 'cimd',
    });
  });

  it('returns null when the document claims a different client_id', async () => {
    respondWith(
      JSON.stringify({
        client_id: 'https://somewhere.else/metadata',
        redirect_uris: ['https://client.example/callback'],
      }),
    );

    assert.equal(await resolveClient('https://client.example/metadata'), null);
  });
});
