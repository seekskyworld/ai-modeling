/** npm 11.17.0's documented OIDC exchange, restricted to an in-memory channel update. */
import { PACKAGE_NAME } from '../version.ts';
import { semanticVersion } from './release-channel-plan.ts';

const repository = 'seekskyworld/ai-modeling';
const registry = 'https://registry.npmjs.org';
const audience = 'npm:registry.npmjs.org';
const escapedPackage = PACKAGE_NAME.replace('/', '%2f');

export class NpmOidcChannelError extends Error {}
const rejected = (message: string) => new NpmOidcChannelError(message);

function workflowIdentity(env: NodeJS.ProcessEnv, selectedRepository: string) {
  const ref = env.GITHUB_REF ?? '';
  const workflow = `${repository}/.github/workflows/release.yml@${ref}`;
  if (
    selectedRepository !== repository ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_EVENT_NAME !== 'push' ||
    env.GITHUB_REPOSITORY !== repository ||
    !ref.startsWith('refs/tags/v') ||
    env.GITHUB_WORKFLOW_REF !== workflow ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
  )
    throw rejected(
      'Channel authentication requires this repository version-tag release workflow in GitHub Actions.',
    );
  semanticVersion(ref.slice('refs/tags/v'.length));
  let url: URL;
  try {
    url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL ?? '');
  } catch {
    throw rejected('GitHub OIDC request URL is unavailable.');
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.actions.githubusercontent.com') ||
    !url.pathname.endsWith('/idtoken') ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  )
    throw rejected('GitHub OIDC request does not target an approved issuer endpoint.');
  url.searchParams.set('audience', audience);
  return { ref, workflow, sha: env.GITHUB_SHA, url, requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN };
}

async function responseJson(response: Response, stage: string): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw rejected(`${stage} failed with HTTP ${response.status}; no account-token fallback is allowed.`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) {
        await reader.cancel();
        throw rejected(`${stage} returned an oversized credential response.`);
      }
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw rejected(`${stage} response is invalid.`);
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof NpmOidcChannelError) throw error;
    throw rejected(`${stage} credential response could not be read.`);
  } finally {
    reader.releaseLock();
  }
}

async function sensitiveRequest(fetcher: typeof fetch, url: URL | string, init: RequestInit, stage: string) {
  try {
    return await fetcher(url, {
      ...init,
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw rejected(`${stage} request failed; its response is unknown.`);
  }
}

function assertClaims(token: string, identity: ReturnType<typeof workflowIdentity>, now: number) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) throw new Error();
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (
      claims.iss !== 'https://token.actions.githubusercontent.com' ||
      claims.aud !== audience ||
      claims.repository !== repository ||
      claims.sub !== `repo:${repository}:environment:npm` ||
      claims.ref !== identity.ref ||
      claims.workflow_ref !== identity.workflow ||
      claims.sha !== identity.sha ||
      typeof claims.exp !== 'number' ||
      claims.exp * 1000 <= now + 10000 ||
      typeof claims.iat !== 'number' ||
      claims.iat * 1000 > now + 60000 ||
      claims.exp - claims.iat > 3600
    )
      throw new Error();
  } catch {
    throw rejected(
      'GitHub OIDC claims do not match the release repository, workflow, tag and npm environment.',
    );
  }
  // The issuer HTTPS response supplies the token; npm verifies its signature during exchange.
}

export async function setNpmChannelWithOidc(
  input: { repository: string; channel: 'latest' | 'next'; version: string },
  dependencies: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; now?: () => number } = {},
) {
  const parsed = semanticVersion(input.version);
  if (!['latest', 'next'].includes(input.channel) || (input.channel === 'latest' && parsed.prerelease.length))
    throw rejected('Only stable latest or the next channel may be promoted.');
  const env = dependencies.env ?? process.env;
  const identity = workflowIdentity(env, input.repository);
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const issued = await responseJson(
    await sensitiveRequest(
      fetcher,
      identity.url,
      {
        headers: { accept: 'application/json', authorization: `Bearer ${identity.requestToken}` },
      },
      'GitHub OIDC',
    ),
    'GitHub OIDC',
  );
  if (typeof issued.value !== 'string' || issued.value.length > 32768)
    throw rejected('GitHub OIDC returned no usable identity token.');
  assertClaims(issued.value, identity, now());
  const exchanged = await responseJson(
    await sensitiveRequest(
      fetcher,
      `${registry}/-/npm/v1/oidc/token/exchange/package/${escapedPackage}`,
      {
        method: 'POST',
        headers: { accept: 'application/json', authorization: `Bearer ${issued.value}` },
      },
      'npm package token exchange',
    ),
    'npm package token exchange',
  );
  const token = exchangedCredential(exchanged, now());
  const response = await sensitiveRequest(
    fetcher,
    `${registry}/-/package/${escapedPackage}/dist-tags/${input.channel}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(input.version),
    },
    'npm dist-tag',
  );
  await response.body?.cancel();
  if (!response.ok)
    throw rejected(
      `npm dist-tag failed with HTTP ${response.status}; the channel must be read back before recovery.`,
    );
}

function exchangedCredential(exchanged: Record<string, unknown>, now: number): string {
  if (
    typeof exchanged.token !== 'string' ||
    exchanged.token.length < 16 ||
    exchanged.token.length > 16384 ||
    /[\r\n]/.test(exchanged.token)
  )
    throw rejected('npm package token exchange returned no usable credential.');
  if (
    exchanged.expires !== undefined &&
    (typeof exchanged.expires !== 'string' ||
      !Number.isFinite(Date.parse(exchanged.expires)) ||
      Date.parse(exchanged.expires) <= now ||
      Date.parse(exchanged.expires) > now + 3600000 + 60000)
  )
    throw rejected('npm exchanged credential has an invalid short-lived expiry.');
  return exchanged.token;
}
