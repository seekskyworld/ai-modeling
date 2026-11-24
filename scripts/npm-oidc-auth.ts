/** Package-scoped npm OIDC exchange. Credentials stay in memory and are never logged. */
import { PACKAGE_NAME } from '../version.ts';
import { semanticVersion } from './release-channel-plan.ts';

const repository = 'seekskyworld/ai-modeling';
const audience = 'npm:registry.npmjs.org';
export const npmRegistry = 'https://registry.npmjs.org';
export const escapedNpmPackage = PACKAGE_NAME.replace('/', '%2f');

export type NpmOidcStage =
  'workflow_identity' | 'github_oidc' | 'github_claims' | 'npm_exchange' | 'npm_credential' | 'npm_dist_tag';
export type NpmOidcFailureCode =
  | 'WORKFLOW_IDENTITY'
  | 'REQUEST_ENDPOINT'
  | 'REQUEST_FAILED'
  | 'HTTP_ERROR'
  | 'RESPONSE_INVALID'
  | 'RESPONSE_UNREADABLE'
  | 'RESPONSE_OVERSIZED'
  | 'IDENTITY_TOKEN_INVALID'
  | 'CLAIMS_INVALID'
  | 'CREDENTIAL_INVALID'
  | 'CREDENTIAL_EXPIRY'
  | 'CHANNEL_INVALID';
export interface NpmOidcProgress {
  stage: NpmOidcStage;
  outcome: 'passed';
  http_status?: number;
}
export interface NpmOidcDependencies {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  now?: () => number;
  observe?: (progress: NpmOidcProgress) => void;
}

export class NpmOidcError extends Error {
  readonly stage: NpmOidcStage;
  readonly code: NpmOidcFailureCode;
  readonly httpStatus?: number;

  constructor(stage: NpmOidcStage, code: NpmOidcFailureCode, message: string, httpStatus?: number) {
    super(message);
    this.stage = stage;
    this.code = code;
    this.httpStatus = safeHttpStatus(httpStatus);
  }
}

function safeHttpStatus(status: number | undefined): number | undefined {
  return status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function assertVersionTag(ref: string) {
  try {
    if (!ref.startsWith('refs/tags/v')) throw new Error();
    semanticVersion(ref.slice('refs/tags/v'.length));
  } catch {
    throw new NpmOidcError(
      'workflow_identity',
      'WORKFLOW_IDENTITY',
      'Release tag is not a canonical version.',
    );
  }
}

function workflowIdentity(env: NodeJS.ProcessEnv, selectedRepository: string) {
  const ref = env.GITHUB_REF ?? '';
  const workflow = `${repository}/.github/workflows/release.yml@${ref}`;
  if (
    selectedRepository !== repository ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_EVENT_NAME !== 'push' ||
    env.GITHUB_REPOSITORY !== repository ||
    env.GITHUB_WORKFLOW_REF !== workflow ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
  )
    throw new NpmOidcError(
      'workflow_identity',
      'WORKFLOW_IDENTITY',
      'Channel authentication requires this repository version-tag release workflow in GitHub Actions.',
    );
  assertVersionTag(ref);
  let url: URL;
  try {
    url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL ?? '');
  } catch {
    throw new NpmOidcError(
      'workflow_identity',
      'REQUEST_ENDPOINT',
      'GitHub OIDC request URL is unavailable.',
    );
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.actions.githubusercontent.com') ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  )
    throw new NpmOidcError(
      'workflow_identity',
      'REQUEST_ENDPOINT',
      'GitHub OIDC request does not target an approved issuer endpoint.',
    );
  // GitHub supplies an opaque endpoint; supported runners do not share a pathname suffix.
  url.searchParams.set('audience', audience);
  return {
    ref,
    workflow,
    sha: env.GITHUB_SHA,
    url,
    requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    repositoryId: env.GITHUB_REPOSITORY_ID,
    ownerId: env.GITHUB_REPOSITORY_OWNER_ID,
  };
}

const requestLabels = {
  github_oidc: 'GitHub OIDC',
  npm_exchange: 'npm package token exchange',
  npm_dist_tag: 'npm dist-tag',
} as const;
type RequestStage = keyof typeof requestLabels;

/** A rejected body cancellation must never replace a sanitized HTTP failure. */
export async function discardOidcResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Response bodies and transport errors may contain credentials; neither is diagnostic output.
  }
}

async function responseJson(response: Response, stage: RequestStage): Promise<Record<string, unknown>> {
  const label = requestLabels[stage];
  if (!response.ok || !response.body) {
    await discardOidcResponse(response);
    throw new NpmOidcError(
      stage,
      'HTTP_ERROR',
      `${label} failed with HTTP ${response.status}; no account-token fallback is allowed.`,
      response.status,
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the fixed size-limit failure even if cancellation itself rejects.
        }
        throw new NpmOidcError(
          stage,
          'RESPONSE_OVERSIZED',
          `${label} returned an oversized credential response.`,
        );
      }
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new NpmOidcError(stage, 'RESPONSE_INVALID', `${label} response is invalid.`);
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof NpmOidcError) throw error;
    throw new NpmOidcError(stage, 'RESPONSE_UNREADABLE', `${label} credential response could not be read.`);
  } finally {
    try {
      reader?.releaseLock();
    } catch {
      // Never expose a stream's exception or override an authentication failure.
    }
  }
}

export async function oidcRequest(
  fetcher: typeof fetch,
  url: URL | string,
  init: RequestInit,
  stage: RequestStage,
) {
  try {
    return await fetcher(url, {
      ...init,
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new NpmOidcError(
      stage,
      'REQUEST_FAILED',
      `${requestLabels[stage]} request failed; its response is unknown.`,
    );
  }
}

function subjectMatches(claims: Record<string, unknown>, identity: ReturnType<typeof workflowIdentity>) {
  const legacy = `repo:${repository}:environment:npm`;
  const { repositoryId, ownerId } = identity;
  // Existing repositories may still emit the legacy subject. Any supplied IDs bind both formats.
  if (repositoryId === undefined && ownerId === undefined) return claims.sub === legacy;
  if (
    !repositoryId ||
    !ownerId ||
    !/^[1-9]\d*$/.test(repositoryId) ||
    !/^[1-9]\d*$/.test(ownerId) ||
    claims.repository_id !== repositoryId ||
    claims.repository_owner_id !== ownerId
  )
    return false;
  const [owner, name] = repository.split('/');
  const immutable = `repo:${owner}@${ownerId}/${name}@${repositoryId}:environment:npm`;
  return claims.sub === legacy || claims.sub === immutable;
}

function assertClaims(token: string, identity: ReturnType<typeof workflowIdentity>, now: number) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (
      !Number.isFinite(now) ||
      claims.iss !== 'https://token.actions.githubusercontent.com' ||
      claims.aud !== audience ||
      claims.repository !== repository ||
      !subjectMatches(claims, identity) ||
      claims.ref !== identity.ref ||
      claims.workflow_ref !== identity.workflow ||
      claims.sha !== identity.sha ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp * 1000 <= now + 10000 ||
      !Number.isSafeInteger(claims.iat) ||
      claims.iat * 1000 > now + 60000 ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 3600
    )
      throw new Error();
  } catch {
    throw new NpmOidcError(
      'github_claims',
      'CLAIMS_INVALID',
      'GitHub OIDC claims do not match the release repository, workflow, tag and npm environment.',
    );
  }
  // The issuer HTTPS response supplies the token; npm verifies its signature during exchange.
}

function exchangedCredential(exchanged: Record<string, unknown>, now: number): string {
  if (
    typeof exchanged.token !== 'string' ||
    exchanged.token.length < 16 ||
    exchanged.token.length > 16384 ||
    /[\r\n]/.test(exchanged.token)
  )
    throw new NpmOidcError(
      'npm_credential',
      'CREDENTIAL_INVALID',
      'npm package token exchange returned no usable credential.',
    );
  if (
    !Number.isFinite(now) ||
    (exchanged.expires !== undefined &&
      (typeof exchanged.expires !== 'string' ||
        !Number.isFinite(Date.parse(exchanged.expires)) ||
        Date.parse(exchanged.expires) <= now ||
        Date.parse(exchanged.expires) > now + 3600000 + 60000))
  )
    throw new NpmOidcError(
      'npm_credential',
      'CREDENTIAL_EXPIRY',
      'npm exchanged credential has an invalid short-lived expiry.',
    );
  return exchanged.token;
}

/** Only issuer GET + package exchange POST; this function never uploads or changes a dist-tag. */
export async function exchangeNpmOidcCredential(
  input: { repository: string },
  dependencies: NpmOidcDependencies = {},
): Promise<string> {
  const identity = workflowIdentity(dependencies.env ?? process.env, input.repository);
  const observe = dependencies.observe;
  observe?.({ stage: 'workflow_identity', outcome: 'passed' });
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const issuerResponse = await oidcRequest(
    fetcher,
    identity.url,
    { headers: { accept: 'application/json', authorization: `Bearer ${identity.requestToken}` } },
    'github_oidc',
  );
  const issued = await responseJson(issuerResponse, 'github_oidc');
  if (typeof issued.value !== 'string' || !issued.value || issued.value.length > 32768)
    throw new NpmOidcError(
      'github_oidc',
      'IDENTITY_TOKEN_INVALID',
      'GitHub OIDC returned no usable identity token.',
    );
  observe?.({ stage: 'github_oidc', outcome: 'passed', http_status: safeHttpStatus(issuerResponse.status) });
  assertClaims(issued.value, identity, now());
  observe?.({ stage: 'github_claims', outcome: 'passed' });
  const exchangeResponse = await oidcRequest(
    fetcher,
    `${npmRegistry}/-/npm/v1/oidc/token/exchange/package/${escapedNpmPackage}`,
    {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${issued.value}` },
    },
    'npm_exchange',
  );
  const exchanged = await responseJson(exchangeResponse, 'npm_exchange');
  observe?.({
    stage: 'npm_exchange',
    outcome: 'passed',
    http_status: safeHttpStatus(exchangeResponse.status),
  });
  const token = exchangedCredential(exchanged, now());
  observe?.({ stage: 'npm_credential', outcome: 'passed' });
  return token;
}
