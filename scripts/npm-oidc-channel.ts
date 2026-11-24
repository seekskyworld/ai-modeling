/** npm 11.17.0's documented OIDC exchange, restricted to an in-memory channel update. */
import { semanticVersion } from './release-channel-plan.ts';
import {
  discardOidcResponse,
  escapedNpmPackage,
  exchangeNpmOidcCredential,
  NpmOidcError,
  npmRegistry,
  oidcRequest,
} from './npm-oidc-auth.ts';

export { NpmOidcError as NpmOidcChannelError } from './npm-oidc-auth.ts';

export async function setNpmChannelWithOidc(
  input: { repository: string; channel: 'latest' | 'next'; version: string },
  dependencies: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; now?: () => number } = {},
) {
  const parsed = semanticVersion(input.version);
  if (!['latest', 'next'].includes(input.channel) || (input.channel === 'latest' && parsed.prerelease.length))
    throw new NpmOidcError(
      'npm_dist_tag',
      'CHANNEL_INVALID',
      'Only stable latest or the next channel may be promoted.',
    );
  const token = await exchangeNpmOidcCredential(input, dependencies);
  const response = await oidcRequest(
    dependencies.fetcher ?? fetch,
    `${npmRegistry}/-/package/${escapedNpmPackage}/dist-tags/${input.channel}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(input.version),
    },
    'npm_dist_tag',
  );
  await discardOidcResponse(response);
  if (!response.ok)
    throw new NpmOidcError(
      'npm_dist_tag',
      'HTTP_ERROR',
      `npm dist-tag failed with HTTP ${response.status}; the channel must be read back before recovery.`,
      response.status,
    );
}
