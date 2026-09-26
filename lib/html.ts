/**
 * The OAuth error pages.
 *
 * Shared by /authorize and /callback, which both render a bare page when a
 * request cannot be completed. Neither page is decoration: the text they show
 * can come from a thrown error, and an error's message can quote input this
 * server never chose — a client metadata document served from a `client_id`
 * URL, say. So everything interpolated here is escaped.
 */

/** Ampersand first, or the entities below get decoded twice. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function errorPage(
  title: string,
  detail: string,
  status = 400,
  footer?: string,
): Response {
  const safeTitle = escapeHtml(title);
  const footerMarkup = footer
    ? `<p style="color:#666">${escapeHtml(footer)}</p>`
    : '';
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${safeTitle}</title>` +
      `<body style="font:15px/1.6 system-ui;margin:3rem auto;max-width:34rem;padding:0 1rem">` +
      `<h1 style="font-size:1.2rem">${safeTitle}</h1><p>${escapeHtml(detail)}</p>` +
      `${footerMarkup}</body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}
