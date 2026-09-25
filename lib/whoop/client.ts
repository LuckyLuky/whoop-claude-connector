import { WHOOP_API_BASE, WHOOP_MAX_PAGE_SIZE } from './constants.ts';
import { getValidAccessToken } from './tokens.ts';

export class WhoopApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = 'WhoopApiError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface PagedResponse<T> {
  records: T[];
  next_token?: string | null;
}

export class WhoopClient {
  private readonly whoopTokenId: string;

  constructor(whoopTokenId: string) {
    this.whoopTokenId = whoopTokenId;
  }

  private async request<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    rejectedToken?: string,
  ): Promise<T> {
    const url = new URL(`${WHOOP_API_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const accessToken = await getValidAccessToken(this.whoopTokenId, {
      rejectedToken,
    });

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });

    if (response.status === 401 && rejectedToken === undefined) {
      // Token was rejected despite looking fresh — replace it and retry once.
      return this.request<T>(path, params, accessToken);
    }

    if (response.status === 429) {
      const reset = response.headers.get('X-RateLimit-Reset');
      throw new WhoopApiError(
        `WHOOP rate limit exceeded (100 req/min, 10,000 req/day).${
          reset ? ` Retry in ${reset}s.` : ''
        }`,
        429,
        reset ? Number(reset) : undefined,
      );
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new WhoopApiError(
        `WHOOP API ${response.status} on ${path}: ${detail.slice(0, 300)}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }

  /** Single resource fetch. */
  get<T>(path: string, params?: Record<string, string | number | undefined>) {
    return this.request<T>(path, params);
  }

  /**
   * Walks a paginated collection until `maxRecords` is reached or WHOOP stops
   * returning a continuation token. Callers get a complete answer instead of
   * the first ten records, which is what makes these usable as MCP tools.
   */
  async collect<T>(
    path: string,
    params: { start?: string; end?: string } = {},
    maxRecords = 50,
  ): Promise<T[]> {
    const records: T[] = [];
    let nextToken: string | undefined;

    while (records.length < maxRecords) {
      const page = await this.request<PagedResponse<T>>(path, {
        ...params,
        limit: Math.min(WHOOP_MAX_PAGE_SIZE, maxRecords - records.length),
        nextToken,
      });

      records.push(...(page.records ?? []));

      if (!page.next_token) break;
      nextToken = page.next_token;
    }

    return records.slice(0, maxRecords);
  }
}
