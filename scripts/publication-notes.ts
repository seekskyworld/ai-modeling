/** Describe verified original release bytes and their immutable pricing source; never publish. */
import { execFile } from 'node:child_process';
import { lstat, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { z } from 'zod';
import { PACKAGE_NAME } from '../version.ts';
import { priceSchema } from '../studio/api/pricing.ts';
import { archiveEntries } from './archive-input.ts';
import { digest, publicationFile, publicationVersion } from './npm-publication-state.ts';

const execute = promisify(execFile);
const priceLimit = 1024 * 1024;
const pricePath = 'studio/api/reviewed-prices.json';
class PublicationNotesError extends Error {}
function safeNotesError(error: unknown): PublicationNotesError {
  return error instanceof PublicationNotesError
    ? error
    : new PublicationNotesError(
        'Original publication inputs could not be verified or notes could not be written.',
      );
}
function notesJson(bytes: Buffer, stage: 'verification' | 'package metadata' | 'pricing'): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new PublicationNotesError(`Original ${stage} JSON could not be parsed.`);
  }
}
const hash = (length: number) => z.string().regex(new RegExp(`^[a-f0-9]{${length}}$`));
const verificationSchema = z.object({
  schema_version: z.literal(1),
  name: z.literal(PACKAGE_NAME),
  version: z.string(),
  repository: z.string(),
  tag: z.string(),
  source: z.string(),
  action: z.literal('published'),
  state: z.literal('published'),
  dry_run: z.literal(false),
  registry_tarball_downloaded: z.literal(true),
  archive_sha256: hash(64),
  archive_sha512: hash(128),
  verification: z.object({
    checked_at: z.iso.datetime(),
    metadata_url: z.url(),
    tarball_url: z.url(),
    size: z.number().int().positive(),
    sha256: hash(64),
    sha512: hash(128),
    integrity: z.string(),
    shasum: hash(40),
  }),
});
type VerifiedPublication = z.infer<typeof verificationSchema>;

export interface PublicationNotesInput {
  verification: unknown;
  archive: Buffer;
  sourcePricing: Buffer;
}
export interface PublicationNotesOptions {
  verification: string;
  archive: string;
  out: string;
  sourceDir?: string;
}

export const publicationNotesHelp = `Usage:
  node scripts/publication-notes.ts --verification VERIFIED.json --archive ORIGINAL.tgz --out NEW.md [--source-dir GIT_CHECKOUT]

Requires a durable, non-dry-run published result and the matching original TGZ.
Pricing is compared with the JSON at the original source commit, never the working
tree or current version. With --source-dir, that commit must exist locally; without
it, the exact public GitHub raw URL is read with redirects disabled. The output
includes the source JSON's raw-byte SHA-256, not a normalized JSON or TGZ digest.
No login, npm upload, expiry extension or remote write occurs. Output must be a new
file outside this source tree; its parent directory must already exist.
`;

export function parsePublicationNotesArgs(args: string[]): PublicationNotesOptions | undefined {
  if (!args.length || (args.length === 1 && args[0] === '--help')) return;
  const names = new Set(['--verification', '--archive', '--out', '--source-dir']);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (!names.has(name) || values.has(name))
      throw new PublicationNotesError('Unknown or duplicate notes argument.');
    const value = args[++index];
    if (!value?.trim() || value.startsWith('-'))
      throw new PublicationNotesError(`Missing notes argument: ${name}`);
    values.set(name, value);
  }
  for (const name of ['--verification', '--archive', '--out'])
    if (!values.has(name)) throw new PublicationNotesError(`Publication notes require ${name}.`);
  return {
    verification: values.get('--verification')!,
    archive: values.get('--archive')!,
    out: values.get('--out')!,
    sourceDir: values.get('--source-dir'),
  };
}

function registryUrl(value: string, pathname: string): boolean {
  const url = new URL(value);
  return (
    url.origin === 'https://registry.npmjs.org' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    decodeURIComponent(url.pathname) === pathname
  );
}

function verifiedPublication(value: unknown): VerifiedPublication {
  const parsed = verificationSchema.safeParse(value);
  if (!parsed.success)
    throw new PublicationNotesError('Notes require a complete non-dry-run published verification.');
  const publication = parsed.data;
  const proof = publication.verification;
  if (
    publicationVersion(publication) !== publication.version ||
    !registryUrl(proof.metadata_url, `/${PACKAGE_NAME}/${publication.version}`) ||
    !registryUrl(proof.tarball_url, `/${PACKAGE_NAME}/-/ai-modeling-${publication.version}.tgz`)
  )
    throw new PublicationNotesError(
      'Publication version or registry source differs from the frozen identity.',
    );
  return publication;
}

function frozenPrice(publication: VerifiedPublication, archive: Buffer): Buffer {
  const proof = publication.verification;
  if (
    archive.length > 256 * 1024 * 1024 ||
    archive.length !== proof.size ||
    digest(archive) !== publication.archive_sha256 ||
    proof.sha256 !== publication.archive_sha256 ||
    digest(archive, 'sha512') !== publication.archive_sha512 ||
    proof.sha512 !== publication.archive_sha512 ||
    digest(archive, 'sha1') !== proof.shasum ||
    proof.integrity !== `sha512-${Buffer.from(publication.archive_sha512, 'hex').toString('base64')}`
  )
    throw new PublicationNotesError('Notes archive differs from the original publicly verified TGZ.');
  const entries = archiveEntries(archive);
  const metadata = entries.find((entry) => entry.path === 'package.json');
  const identity = metadata && notesJson(metadata.bytes, 'package metadata');
  if (
    !identity ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    !('name' in identity) ||
    identity.name !== PACKAGE_NAME ||
    !('version' in identity) ||
    identity.version !== publication.version
  )
    throw new PublicationNotesError('Notes archive package identity differs from the published version.');
  const price = entries.find((entry) => entry.path === `dist/${pricePath}`);
  if (!price) throw new PublicationNotesError('The frozen runtime has no reviewed pricing JSON.');
  return price.bytes;
}

function priceSourceUrl(publication: VerifiedPublication): string {
  return `https://raw.githubusercontent.com/${publication.repository}/${publication.source}/${pricePath}`;
}

function pricingProof(publication: VerifiedPublication, bundled: Buffer, source: Buffer) {
  if (bundled.length > priceLimit || source.length > priceLimit)
    throw new PublicationNotesError('Reviewed pricing JSON exceeds 1 MiB.');
  const originalValue = notesJson(source, 'pricing');
  const runtimeValue = notesJson(bundled, 'pricing');
  const originalResult = priceSchema.safeParse(originalValue);
  const runtimeResult = priceSchema.safeParse(runtimeValue);
  if (!originalResult.success || !runtimeResult.success)
    throw new PublicationNotesError('Reviewed pricing JSON does not match the required schema.');
  const original = originalResult.data;
  // TypeScript may change JSON formatting during emit. Compare all parsed fields,
  // but publish the hash of the original source bytes consumed by pricing update.
  if (!isDeepStrictEqual(originalValue, runtimeValue))
    throw new PublicationNotesError('Frozen runtime pricing differs from the original source commit.');
  if (!original.evidence.length || Date.parse(original.expires_at) <= Date.parse(original.reviewed_at))
    throw new PublicationNotesError(
      'Reviewed pricing requires evidence and a valid original review interval.',
    );
  return {
    source_url: priceSourceUrl(publication),
    sha256: digest(source),
    reviewed_at: original.reviewed_at,
    expires_at: original.expires_at,
  };
}

function notes(publication: VerifiedPublication, pricing: ReturnType<typeof pricingProof>): string {
  const repository = `https://github.com/${publication.repository}`;
  return [
    'Install the published runtime:',
    '',
    '```sh',
    `npm install --global ${PACKAGE_NAME}@${publication.version}`,
    '```',
    '',
    'The CLI, MCP server and Agent Skill use this runtime. The attached Skill ZIP and MCP configuration provide the alternative entry points.',
    '',
    'The public npm tarball was downloaded and matched against the original frozen archive.',
    `Runtime TGZ SHA-256: \`${publication.archive_sha256}\`.`,
    '',
    `Source commit: ${repository}/commit/${publication.source}`,
    `Changes: ${repository}/blob/${publication.tag}/CHANGELOG.md`,
    '',
    '## Reviewed pricing snapshot',
    '',
    "The pricing JSON in this exact runtime matches the JSON at its original source commit. The digest below covers that source file's original bytes, including formatting; it is not the runtime archive or canonical JSON digest.",
    '',
    `Source JSON: ${pricing.source_url}`,
    `Source JSON SHA-256: \`${pricing.sha256}\``,
    `Reviewed at: \`${pricing.reviewed_at}\``,
    `Expires at: \`${pricing.expires_at}\``,
    '',
    'To install this reviewed snapshot through the CLI:',
    '',
    '```sh',
    `ai-modeling pricing update "${pricing.source_url}" --sha256 ${pricing.sha256}`,
    'ai-modeling pricing status',
    '```',
    '',
    'The updater checks the original file digest and official evidence. Expired snapshots remain rejected; obtain a newer reviewed release when needed. Publication and recovery do not extend this validity period. MCP users keep their selected entry point and ask the runtime maintainer to perform any required price update.',
    '',
  ].join('\n');
}

/** Pure rendering retains the historical version and never substitutes current source prices. */
export function renderPublicationNotes(input: PublicationNotesInput): string {
  try {
    const publication = verifiedPublication(input.verification);
    const bundled = frozenPrice(publication, input.archive);
    return notes(publication, pricingProof(publication, bundled, input.sourcePricing));
  } catch (error) {
    throw safeNotesError(error);
  }
}

async function sourceFromGit(directory: string, publication: VerifiedPublication): Promise<Buffer> {
  const { stdout } = await execute(
    'git',
    ['--no-replace-objects', 'cat-file', 'blob', `${publication.source}:${pricePath}`],
    { cwd: path.resolve(directory), encoding: 'buffer', maxBuffer: priceLimit, timeout: 30000 },
  );
  return stdout;
}

async function sourceFromUrl(publication: VerifiedPublication, fetcher: typeof fetch): Promise<Buffer> {
  const response = await fetcher(priceSourceUrl(publication), {
    headers: { accept: 'application/json' },
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new PublicationNotesError(`Original pricing source could not be read (HTTP ${response.status}).`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > priceLimit) throw new PublicationNotesError('Original pricing source exceeds 1 MiB.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

async function newOutput(filename: string): Promise<string> {
  const parent = await realpath(path.dirname(path.resolve(filename)));
  const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const relative = path.relative(root, parent);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
    throw new PublicationNotesError('Publication notes must be outside the source tree.');
  const output = path.join(parent, path.basename(filename));
  try {
    await lstat(output);
    throw new PublicationNotesError('Publication notes output already exists.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return output;
}

export async function runPublicationNotes(options: PublicationNotesOptions, fetcher = fetch) {
  try {
    const output = await newOutput(options.out);
    const publication = verifiedPublication(
      notesJson(await publicationFile(options.verification, priceLimit), 'verification'),
    );
    const archive = await publicationFile(options.archive);
    const bundled = frozenPrice(publication, archive);
    const source = options.sourceDir
      ? await sourceFromGit(options.sourceDir, publication)
      : await sourceFromUrl(publication, fetcher);
    const pricing = pricingProof(publication, bundled, source);
    await writeFile(output, notes(publication, pricing), { flag: 'wx', mode: 0o600 });
    return { version: publication.version, source: publication.source, pricing, out: output };
  } catch (error) {
    throw safeNotesError(error);
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const options = parsePublicationNotesArgs(process.argv.slice(2));
    if (!options) process.stdout.write(publicationNotesHelp);
    else process.stdout.write(JSON.stringify(await runPublicationNotes(options)) + '\n');
  } catch (error) {
    process.stderr.write(`publication notes: ${safeNotesError(error).message}\n`);
    process.exitCode = 1;
  }
}
