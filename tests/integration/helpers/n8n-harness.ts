import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { N8N_IMAGE } from '../constants.js';

const OWNER_EMAIL = 'integration-test@chiral.sh';
const OWNER_PASSWORD = 'ChiralIntegrationTest1!';
const OWNER_FIRST_NAME = 'Chiral';
const OWNER_LAST_NAME = 'Integration';

const API_KEY_SCOPES = [
  'workflow:list',
  'workflow:read',
  'workflow:create',
  'workflow:update',
  'workflow:activate',
  'workflow:deactivate',
  'workflow:delete',
  'credential:list',
  'credential:create',
  'credential:delete',
  'tag:list',
  'tag:create',
];

export interface N8nHandle {
  url: string;
  apiKey: string;
  stop: () => Promise<void>;
}

// Extracts the n8n-auth session cookie from a Set-Cookie response header.
function extractAuthCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const match = setCookie.match(/n8n-auth=[^;]+/);
  return match ? match[0] : null;
}

// Logs in as the already-provisioned owner, returning the session cookie.
// Used as a fallback when /rest/owner/setup reports the owner already exists
// (e.g. a reused container with CHIRAL_TEST_KEEP_N8N).
async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/rest/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrLdapLoginId: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  const cookie = extractAuthCookie(response.headers.get('set-cookie'));
  if (!response.ok || !cookie) {
    const body = await response.text();
    throw new Error(`n8n /rest/login failed: ${response.status} ${body}`);
  }
  return cookie;
}

// Bootstraps the n8n owner account (or logs in if it already exists) and
// returns the authenticated session cookie.
// /healthz can return 200 while n8n is still finishing DB migrations, in
// which case /rest/* responds 200 with a plaintext "starting up" body and
// no session cookie. Retry until the REST API is actually ready.
async function bootstrapOwner(baseUrl: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await fetch(`${baseUrl}/rest/owner/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: OWNER_EMAIL,
        firstName: OWNER_FIRST_NAME,
        lastName: OWNER_LAST_NAME,
        password: OWNER_PASSWORD,
      }),
    });
    if (response.ok) {
      const cookie = extractAuthCookie(response.headers.get('set-cookie'));
      if (cookie) return cookie;
      const body = await response.text();
      if (body.includes('starting up') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw new Error(`n8n /rest/owner/setup did not return a session cookie: ${response.status} ${body}`);
    }
    // Owner already exists (e.g. reused container) — fall back to login.
    return login(baseUrl);
  }
}

// Creates a Public API key for the bootstrapped owner via the private
// /rest/api-keys endpoint, returning the raw (unhashed) key.
async function createApiKey(baseUrl: string, cookie: string): Promise<string> {
  const response = await fetch(`${baseUrl}/rest/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      label: 'chiral-integration-tests',
      expiresAt: null,
      scopes: API_KEY_SCOPES,
    }),
  });
  const body = await response.json().catch(() => null) as { rawApiKey?: string; apiKey?: string; data?: { rawApiKey?: string; apiKey?: string } } | null;
  const key = body?.rawApiKey ?? body?.apiKey ?? body?.data?.rawApiKey ?? body?.data?.apiKey;
  if (!response.ok || !key) {
    throw new Error(`n8n /rest/api-keys did not return a raw key: ${response.status} ${JSON.stringify(body)}`);
  }
  return key;
}

// Starts a pinned n8n container, bootstraps an owner account, and mints a
// Public API key via the private /rest/* surface. Throws with the raw
// status/body if any /rest/* step fails so drift after an image bump is
// loud and immediate.
export async function startN8n(): Promise<N8nHandle> {
  const container = await new GenericContainer(N8N_IMAGE)
    .withExposedPorts(5678)
    .withEnvironment({
      N8N_PUBLIC_API_DISABLED: 'false',
      N8N_DIAGNOSTICS_ENABLED: 'false',
      N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
      N8N_TEMPLATES_ENABLED: 'false',
      N8N_SECURE_COOKIE: 'false',
    })
    .withWaitStrategy(Wait.forHttp('/healthz', 5678).forStatusCode(200))
    .start();

  const url = `http://${container.getHost()}:${container.getMappedPort(5678)}`;

  // /healthz can return 200 before all REST routes are mounted, so the
  // first bootstrap attempt(s) may 404/error transiently — retry briefly.
  const deadline = Date.now() + 60_000;
  let cookie: string;
  for (;;) {
    try {
      cookie = await bootstrapOwner(url);
      break;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const apiKey = await createApiKey(url, cookie);

  return {
    url,
    apiKey,
    stop: async (): Promise<void> => {
      await (container as StartedTestContainer).stop();
    },
  };
}
