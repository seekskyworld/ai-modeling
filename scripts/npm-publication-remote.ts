/** GitHub receipt persistence and anonymous, bounded npm verification. */
import { createHash } from 'node:crypto';
import { PACKAGE_NAME } from '../version.ts';
import {
  publicationVersion,
  type PublicationContext,
  type PublicationIdentity,
  type RegistryProof,
} from './npm-publication-state.ts';

export interface PublicationRelease {
  id: number;
  tag: string;
  draft: boolean;
  assets: { id: number; name: string; size: number }[];
}
export interface PublicationStore {
  assertTag(context: PublicationContext): Promise<void>;
  load(context: PublicationContext): Promise<PublicationRelease | undefined>;
  create(context: PublicationContext): Promise<PublicationRelease>;
  read(release: PublicationRelease, name: string, maximumBytes: number): Promise<Buffer | undefined>;
  put(release: PublicationRelease, name: string, bytes: Buffer): Promise<void>;
}

export async function boundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error('Remote response has no body.');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error('Remote response exceeds its frozen size limit.');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts);
}

export class GitHubPublicationStore implements PublicationStore {
  repository: string;
  token: string | undefined;
  fetcher: typeof fetch;
  constructor(repository: string, token?: string, fetcher: typeof fetch = fetch) {
    this.repository = repository;
    this.token = token;
    this.fetcher = fetcher;
  }

  async request(
    route: string,
    method = 'GET',
    body?: Buffer,
    upload = false,
    accept = 'application/vnd.github+json',
  ) {
    if (method !== 'GET' && !this.token) throw new Error('GitHub remote writes require GITHUB_TOKEN.');
    const response = await this.fetcher(
      `https://${upload ? 'uploads' : 'api'}.github.com/repos/${this.repository}${route}`,
      {
        method,
        body: body ? new Uint8Array(body) : undefined,
        redirect: 'manual',
        credentials: 'omit',
        headers: {
          accept,
          'x-github-api-version': '2022-11-28',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body ? { 'content-type': upload ? 'application/octet-stream' : 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(upload ? 300000 : 30000),
      },
    );
    return response;
  }

  async json(route: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await this.request(
      route,
      method,
      body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
    );
    if (response.status === 404 && method === 'GET') {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub ${method} failed with HTTP ${response.status}; no write is retried.`);
    }
    return JSON.parse((await boundedResponse(response, 4 * 1024 * 1024)).toString('utf8'));
  }

  async assertTag(context: PublicationContext) {
    publicationVersion(context);
    let value = (await this.json(`/git/ref/tags/${encodeURIComponent(context.tag)}`)) as
      { object?: { type: string; sha: string } } | undefined;
    let object = value?.object;
    for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
      value = (await this.json(`/git/tags/${object.sha}`)) as typeof value;
      object = value?.object;
    }
    if (object?.type !== 'commit' || object.sha !== context.source)
      throw new Error('The remote GitHub tag must resolve to the frozen source commit.');
  }

  async release(value: unknown): Promise<PublicationRelease> {
    const data = value as { id?: number; tag_name?: string; draft?: boolean };
    if (
      !Number.isSafeInteger(data?.id) ||
      typeof data.tag_name !== 'string' ||
      typeof data.draft !== 'boolean'
    )
      throw new Error('Invalid GitHub Release identity.');
    const assets: PublicationRelease['assets'] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.json(`/releases/${data.id}/assets?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('Invalid GitHub Release asset inventory.');
      for (const item of batch) {
        if (
          !Number.isSafeInteger(item?.id) ||
          typeof item.name !== 'string' ||
          !Number.isSafeInteger(item.size)
        )
          throw new Error('Invalid GitHub Release asset.');
        assets.push({ id: item.id, name: item.name, size: item.size });
      }
      if (batch.length < 100) return { id: data.id!, tag: data.tag_name, draft: data.draft, assets };
    }
    throw new Error('GitHub asset inventory exceeds the bounded page limit.');
  }

  async load(context: PublicationContext) {
    if (!this.token)
      throw new Error('Release reconciliation requires GITHUB_TOKEN so draft releases are visible.');
    const matches: unknown[] = [];
    // The tag endpoint documents published releases only. Authenticated listing
    // includes drafts and must finish before absence can authorize a new freeze.
    for (let page = 1; page <= 10; page++) {
      const batch = await this.json(`/releases?per_page=100&page=${page}`);
      if (!Array.isArray(batch))
        throw new Error('Release inventory is unavailable; absence is not established.');
      matches.push(...batch.filter((item) => item?.tag_name === context.tag));
      if (matches.length > 1)
        throw new Error('Multiple GitHub Releases use this tag; reconciliation is required.');
      if (batch.length < 100) return matches.length ? this.release(matches[0]) : undefined;
    }
    throw new Error('Release inventory exceeds the bounded page limit; absence is not established.');
  }

  async create(context: PublicationContext) {
    const data = await this.json('/releases', 'POST', {
      tag_name: context.tag,
      target_commitish: context.source,
      name: context.tag,
      draft: true,
      prerelease: context.tag.includes('-'),
      body: 'Publication is pending public npm metadata and archive verification. Immutable npm-publication receipts preserve the original archive identity.',
    });
    return this.release(data);
  }

  async read(release: PublicationRelease, name: string, maximumBytes: number) {
    const matches = release.assets.filter((asset) => asset.name === name);
    if (!matches.length) return;
    if (matches.length !== 1 || matches[0]!.size > maximumBytes)
      throw new Error('Invalid or oversized release asset.');
    let response = await this.request(
      `/releases/assets/${matches[0]!.id}`,
      'GET',
      undefined,
      false,
      'application/octet-stream',
    );
    if (response.status === 302) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      const url = new URL(location ?? '');
      if (
        url.protocol !== 'https:' ||
        !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      )
        throw new Error('GitHub asset redirect does not target an approved HTTPS download host.');
      // Signed download URLs are used only in memory; never persist or print them or forward the token.
      response = await this.fetcher(url, {
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(300000),
      });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub asset read failed with HTTP ${response.status}.`);
    }
    return boundedResponse(response, maximumBytes);
  }

  async put(release: PublicationRelease, name: string, bytes: Buffer) {
    const response = await this.request(
      `/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      'POST',
      bytes,
      true,
    );
    await response.body?.cancel();
    if (response.status !== 201)
      throw new Error(
        `Immutable GitHub asset creation failed with HTTP ${response.status}; no overwrite or retry is allowed.`,
      );
  }
}

export const npmRegistry = 'https://registry.npmjs.org';
const metadataUrl = (version: string) =>
  `${npmRegistry}/${encodeURIComponent(PACKAGE_NAME)}/${encodeURIComponent(version)}`;

export async function publicMetadata(version: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(metadataUrl(version), {
    redirect: 'error',
    credentials: 'omit',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Public npm metadata failed with HTTP ${response.status}.`);
  }
  const metadata = JSON.parse((await boundedResponse(response, 1024 * 1024)).toString('utf8'));
  if (metadata?.name !== PACKAGE_NAME || metadata.version !== version)
    throw new Error('Public npm metadata names another package or version.');
  return metadata as {
    name: string;
    version: string;
    dist?: { integrity?: string; shasum?: string; tarball?: string };
  };
}

function verifiedTarball(
  identity: PublicationIdentity,
  dist: NonNullable<Awaited<ReturnType<typeof publicMetadata>>>['dist'],
) {
  if (
    typeof dist?.integrity !== 'string' ||
    !dist.integrity.split(/\s+/).includes(identity.archive.integrity) ||
    (dist.shasum !== undefined && dist.shasum !== identity.archive.shasum)
  )
    throw new Error('Public npm metadata integrity differs from the frozen archive.');
  const url = new URL(dist.tarball ?? '');
  const expectedPath = `/@seekskyworld/ai-modeling/-/ai-modeling-${identity.version}.tgz`;
  if (
    url.origin !== npmRegistry ||
    decodeURIComponent(url.pathname) !== expectedPath ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('Public npm tarball URL does not identify the exact registry package version.');
  return url.href;
}

export async function verifyPublicArchive(
  identity: PublicationIdentity,
  fetcher: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<RegistryProof | undefined> {
  const metadata = await publicMetadata(identity.version, fetcher);
  if (!metadata) return;
  const url = verifiedTarball(identity, metadata.dist);
  const response = await fetcher(url, {
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Public npm tarball failed with HTTP ${response.status}.`);
  }
  if (!response.body) throw new Error('Public npm tarball has no body.');
  const reader = response.body.getReader();
  const hashes = { sha256: createHash('sha256'), sha512: createHash('sha512'), shasum: createHash('sha1') };
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > identity.archive.size) {
        await reader.cancel();
        throw new Error('Public npm tarball exceeds the frozen archive size.');
      }
      Object.values(hashes).forEach((hash) => hash.update(value));
    }
  } finally {
    reader.releaseLock();
  }
  const sha256 = hashes.sha256.digest('hex');
  const sha512 = hashes.sha512.digest('hex');
  const shasum = hashes.shasum.digest('hex');
  if (
    size !== identity.archive.size ||
    sha256 !== identity.archive.sha256 ||
    sha512 !== identity.archive.sha512 ||
    shasum !== identity.archive.shasum
  )
    throw new Error('Downloaded public npm tarball bytes differ from the frozen archive.');
  return {
    checked_at: new Date(nowMs).toISOString(),
    metadata_url: metadataUrl(identity.version),
    tarball_url: url,
    size,
    sha256,
    sha512,
    shasum,
    integrity: identity.archive.integrity,
  };
}
