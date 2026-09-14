import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * WHOOP webhook receiver (optional).
 *
 * The MCP connector itself is pull-based — Claude calls tools on demand — so
 * nothing here is required for the connector to work. It exists because the
 * signature scheme is the fiddly part, and having it verified and working
 * makes the cache/digest follow-ups cheap to add.
 *
 * Events: workout.updated/deleted, sleep.updated/deleted,
 * recovery.updated/deleted. Creates arrive as `updated`. Cycles and day strain
 * have no webhook and must be polled.
 *
 * WHOOP expects a 2xx within about a second and retries up to five times over
 * roughly an hour, so anything slow belongs in a background job, not here.
 */

interface WhoopWebhookEvent {
  user_id: number;
  id: string;
  type: string;
  trace_id: string;
}

function verifySignature(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
): boolean {
  if (!signature || !timestamp) return false;

  const secret = env.whoopWebhookSecret() || env.whoopClientSecret();
  if (!secret) return false;

  const expected = createHmac('sha256', secret)
    .update(timestamp + rawBody)
    .digest('base64');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();

  const valid = verifySignature(
    rawBody,
    request.headers.get('X-WHOOP-Signature'),
    request.headers.get('X-WHOOP-Signature-Timestamp'),
  );

  if (!valid) {
    return new Response('invalid signature', { status: 401 });
  }

  let event: WhoopWebhookEvent;
  try {
    event = JSON.parse(rawBody) as WhoopWebhookEvent;
  } catch {
    return new Response('invalid payload', { status: 400 });
  }

  // TODO: fan out to a cache table or a digest job. Use `trace_id` to drop
  // duplicate deliveries. Acknowledge fast regardless.
  console.log('[whoop-webhook]', event.type, event.id, event.trace_id);

  return new Response(null, { status: 204 });
}
