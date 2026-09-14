import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { env } from '../env';
import { resolveRange, todayIn } from '../dates';
import { WhoopClient, WhoopApiError } from '../whoop/client';
import {
  normalizeCycle,
  normalizeProfile,
  normalizeRecovery,
  normalizeSleep,
  normalizeWorkout,
  type WhoopBodyMeasurement,
  type WhoopCycle,
  type WhoopProfile,
  type WhoopRecovery,
  type WhoopSleep,
  type WhoopWorkout,
} from '../whoop/normalize';

/** Every tool on this server reads; nothing writes back to WHOOP. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const rangeShape = {
  date: z
    .string()
    .optional()
    .describe('A single local calendar day as YYYY-MM-DD. Takes precedence over `days`.'),
  start: z
    .string()
    .optional()
    .describe('ISO-8601 start instant, e.g. 2026-09-01T00:00:00Z. Overrides `date` and `days`.'),
  end: z.string().optional().describe('ISO-8601 end instant. Defaults to now.'),
  days: z
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .describe('Look back this many days from now. Defaults to 7.'),
};

function jsonResult(payload: unknown) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof WhoopApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

/**
 * Builds a stateless MCP server bound to one WHOOP grant.
 *
 * A fresh instance is created per request: the HTTP layer has already proven
 * the bearer token maps to `whoopTokenId` before this is called.
 */
export function buildMcpServer(whoopTokenId: string): McpServer {
  const server = new McpServer(
    { name: 'whoop', version: '0.1.0' },
    {
      instructions:
        'Read-only access to the user\'s WHOOP data: recovery, sleep, day strain, ' +
        'and workouts. Prefer `get_daily_summary` for questions about a single day. ' +
        'All durations are minutes, energy is kilocalories, distances are meters.',
    },
  );

  const whoop = new WhoopClient(whoopTokenId);
  const timeZone = env.timezone();

  server.registerTool(
    'get_recovery',
    {
      title: 'Get recovery',
      description:
        'WHOOP recovery scores over a time range: recovery percentage, resting heart rate, ' +
        'HRV (RMSSD), SpO2 and skin temperature.',
      inputSchema: rangeShape,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const range = resolveRange(args, timeZone);
        const records = await whoop.collect<WhoopRecovery>('/v2/recovery', range);
        return jsonResult({
          range,
          count: records.length,
          recoveries: records.map(normalizeRecovery),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_sleep',
    {
      title: 'Get sleep',
      description:
        'WHOOP sleep records over a time range: time in bed, sleep stages (light/deep/REM), ' +
        'sleep performance, efficiency, consistency, respiratory rate and sleep debt. ' +
        'Includes naps, flagged with is_nap.',
      inputSchema: rangeShape,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const range = resolveRange(args, timeZone);
        const records = await whoop.collect<WhoopSleep>('/v2/activity/sleep', range);
        return jsonResult({
          range,
          count: records.length,
          sleeps: records.map(normalizeSleep),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_strain',
    {
      title: 'Get day strain',
      description:
        'WHOOP physiological cycles over a time range — one per WHOOP "day". Returns day ' +
        'strain (0-21 scale), calories burned, and average/max heart rate.',
      inputSchema: rangeShape,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const range = resolveRange(args, timeZone);
        const records = await whoop.collect<WhoopCycle>('/v2/cycle', range);
        return jsonResult({
          range,
          count: records.length,
          cycles: records.map(normalizeCycle),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_workouts',
    {
      title: 'Get workouts',
      description:
        'WHOOP workouts over a time range: sport, duration, strain, heart rate, heart rate ' +
        'zone distribution, calories, distance and elevation gain.',
      inputSchema: {
        ...rangeShape,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum workouts to return. Defaults to 50.'),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const range = resolveRange(args, timeZone);
        const records = await whoop.collect<WhoopWorkout>(
          '/v2/activity/workout',
          range,
          args.limit ?? 50,
        );
        return jsonResult({
          range,
          count: records.length,
          workouts: records.map(normalizeWorkout),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_profile',
    {
      title: 'Get profile and body measurements',
      description:
        'The WHOOP account holder\'s name, email, height, weight and max heart rate. ' +
        'Changes rarely — call once per conversation at most.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const [profile, body] = await Promise.all([
          whoop.get<WhoopProfile>('/v2/user/profile/basic'),
          whoop
            .get<WhoopBodyMeasurement>('/v2/user/measurement/body')
            .catch(() => undefined),
        ]);
        return jsonResult(normalizeProfile(profile, body));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_daily_summary',
    {
      title: 'Get daily summary',
      description:
        'Everything WHOOP knows about one day in a single call: the day\'s cycle (strain, ' +
        'calories), the recovery score it opened with, and the sleep that preceded it. ' +
        'This is the right tool for "how did I sleep last night" or "how am I doing today".',
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe('Local calendar day as YYYY-MM-DD. Defaults to today.'),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const date = args.date ?? todayIn(timeZone);
        const range = resolveRange({ date }, timeZone);

        const cycles = await whoop.collect<WhoopCycle>('/v2/cycle', range, 3);
        const cycle = cycles[0];

        if (!cycle) {
          return jsonResult({
            date,
            note: 'No WHOOP cycle found for this day. The strap may not have been worn, or the day has not started yet.',
          });
        }

        const [recovery, sleep] = await Promise.all([
          whoop
            .get<WhoopRecovery>(`/v2/cycle/${cycle.id}/recovery`)
            .catch(() => undefined),
          whoop
            .get<WhoopSleep>(`/v2/cycle/${cycle.id}/sleep`)
            .catch(() => undefined),
        ]);

        return jsonResult({
          date,
          cycle: normalizeCycle(cycle),
          recovery: recovery ? normalizeRecovery(recovery) : null,
          sleep: sleep ? normalizeSleep(sleep) : null,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
