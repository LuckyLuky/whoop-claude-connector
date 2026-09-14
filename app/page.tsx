import { endpoints } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Status page. Reports whether the deployment is configured without ever
 * printing a secret — just whether each variable is present.
 */
export default function Home() {
  const urls = endpoints();

  const checks: Array<{ label: string; ok: boolean }> = [
    { label: 'APP_BASE_URL', ok: Boolean(process.env.APP_BASE_URL) },
    { label: 'WHOOP_CLIENT_ID', ok: Boolean(process.env.WHOOP_CLIENT_ID) },
    { label: 'WHOOP_CLIENT_SECRET', ok: Boolean(process.env.WHOOP_CLIENT_SECRET) },
    { label: 'SUPABASE_URL', ok: Boolean(process.env.SUPABASE_URL) },
    {
      label: 'SUPABASE_SERVICE_ROLE_KEY',
      ok: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
    {
      label: 'TOKEN_ENCRYPTION_KEY',
      ok: Boolean(process.env.TOKEN_ENCRYPTION_KEY),
    },
  ];

  const ready = checks.every((check) => check.ok);

  return (
    <main>
      <h1 style={{ fontSize: '1.35rem', marginBottom: '0.25rem' }}>
        WHOOP · Claude connector
      </h1>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        Remote MCP server. Add this URL as a custom connector in Claude:
      </p>

      <p>
        <code
          style={{
            display: 'inline-block',
            border: '1px solid var(--line)',
            borderRadius: 6,
            padding: '0.5rem 0.7rem',
          }}
        >
          {urls.resource}
        </code>
      </p>

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>Configuration</h2>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {checks.map((check) => (
          <li key={check.label} style={{ borderBottom: '1px solid var(--line)', padding: '0.4rem 0' }}>
            <span style={{ color: check.ok ? 'var(--ok)' : 'var(--bad)' }}>
              {check.ok ? '✓' : '✗'}
            </span>{' '}
            <code>{check.label}</code>
          </li>
        ))}
      </ul>

      <p style={{ color: ready ? 'var(--ok)' : 'var(--bad)' }}>
        {ready
          ? 'All required environment variables are set.'
          : 'Some environment variables are missing — the connector will fail at request time.'}
      </p>

      <h2 style={{ fontSize: '1rem', marginTop: '2rem' }}>Discovery</h2>
      <ul style={{ color: 'var(--muted)' }}>
        <li>
          <code>/.well-known/oauth-protected-resource</code>
        </li>
        <li>
          <code>/.well-known/oauth-authorization-server</code>
        </li>
      </ul>

      <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginTop: '2rem' }}>
        This deployment holds a single WHOOP grant and is intended for personal
        use. It is not listed in Anthropic&apos;s connector directory.
      </p>
    </main>
  );
}
