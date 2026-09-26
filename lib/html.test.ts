import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, errorPage } from './html.ts';

/**
 * The OAuth error pages render text that can originate outside this server: a
 * thrown error's message, and through it whatever a malformed client metadata
 * document put in a parser message. Interpolated raw, that is stored-free
 * reflected XSS on an endpoint the WHOOP account holder is about to sign in on.
 */

describe('escapeHtml', () => {
  it('escapes the characters that would open a tag or attribute', () => {
    assert.equal(
      escapeHtml(`<script>alert("1")</script>`),
      '&lt;script&gt;alert(&quot;1&quot;)&lt;/script&gt;',
    );
  });

  it('escapes ampersands first so entities are not double-decoded', () => {
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  });

  it('leaves ordinary prose alone', () => {
    assert.equal(
      escapeHtml('WHOOP did not return a state parameter.'),
      'WHOOP did not return a state parameter.',
    );
  });

  // Both quote styles are escaped, so a later caller can interpolate into an
  // attribute without reopening this hole. In element text a browser renders
  // the entity as the character, so the copy reads the same either way.
  it('escapes single quotes too', () => {
    assert.equal(escapeHtml("didn't"), 'didn&#39;t');
  });
});

describe('errorPage', () => {
  it('escapes the detail rather than embedding it as markup', async () => {
    const response = errorPage('Authorization failed', '<img src=x onerror=alert(1)>');
    const body = await response.text();

    assert.equal(response.status, 400);
    assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(body, /<img/);
  });

  it('escapes the title, which also lands inside <title>', async () => {
    const body = await errorPage('</title><script>x</script>', 'detail').text();

    assert.doesNotMatch(body, /<script>/);
  });

  it('renders an optional footer line, escaped like the rest', async () => {
    const body = await errorPage('Nope', 'detail', 400, 'Close this <window>').text();

    assert.match(body, /Close this &lt;window&gt;/);
  });

  it('omits the footer paragraph when none is given', async () => {
    const body = await errorPage('Nope', 'detail').text();

    assert.equal(body.match(/<p/g)?.length, 1);
  });

  it('carries the requested status and an HTML content type', () => {
    const response = errorPage('Nope', 'detail', 500);

    assert.equal(response.status, 500);
    assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  });
});
