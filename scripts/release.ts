/** Prepare review evidence only. This command never tags, publishes or contacts a service. */
import { PACKAGE_NAME } from '../version.ts';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pricingSnapshotStatus } from '../cli/pricing.ts';
import { reviewedPrices } from '../studio/api/reviewed-prices.ts';
import { dependencyProvenance, provenanceFields } from './dependency-lock.ts';
import { checkOutput, publishStaged } from './distribution.ts';
import { assertDistributionPath, readPackageMetadata } from './package-validation.ts';

const platforms = ['linux', 'darwin', 'win32'] as const;
const smokeChecks = [
  'installed-bin',
  'version',
  'help',
  'cli-guides',
  'mcp-initialize',
  'mcp-guides',
  'production-lock',
  'static-tool-discovery',
  'focused-command-guides',
  'no-runtime-state',
];
const consumerChecks = [
  'installed-bin',
  'version',
  'help',
  'npm-exec-offline',
  'npx-offline',
  'mcp-initialize',
  'static-tool-discovery',
  'skill-install',
  'skill-status',
  'skill-uninstall',
  'no-runtime-state',
  'dependency-inspection',
  'bundled-file-integrity',
  'global-install',
  'global-bin',
  'global-native-runtime',
  'global-json-credentials',
  'global-mcp',
  'global-skill-management',
  'global-dependency-bytes',
];
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Provenance = Awaited<ReturnType<typeof dependencyProvenance>>;

interface ReleaseOptions {
  command: 'check' | 'prepare';
  repository?: string;
  securityContact?: string;
  minPricingHours: number;
  requireReady: boolean;
  distribution?: string;
  smokeDir?: string;
  out?: string;
}

export const releaseHelp = `Usage:
  npm run release:check -- [--repository URL] [--security-contact URL] [--min-pricing-hours 24] [--require-ready]
  npm run release:prepare -- --distribution DIR --out NEW_DIR [--smoke-dir DIR] [same readiness options]

Check source metadata and bundled price freshness offline, or verify an all-target
export and prepare RELEASE.md, readiness.json and supplied installation reports.
The output must be a new directory outside the source tree; its parent must exist.
Repository: confirmed HTTPS GitHub repository. Security contact: confirmed private
HTTPS reporting form or mailto address. Neither is checked online by this command.
Missing prerequisites are reported as blockers. --require-ready also exits nonzero.
No Release, tag, remote write, npm publication, account access or price refresh occurs.
`;

function releaseFlags(rest: string[]) {
  const values = new Map<string, string>();
  let requireReady = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === '--require-ready') {
      if (requireReady) throw new Error('Duplicate --require-ready.');
      requireReady = true;
      continue;
    }
    const equal = token.indexOf('=');
    const key = equal < 0 ? token : token.slice(0, equal);
    if (
      ![
        '--repository',
        '--security-contact',
        '--min-pricing-hours',
        '--distribution',
        '--smoke-dir',
        '--out',
      ].includes(key)
    )
      throw new Error(`Unknown release argument: ${token}`);
    if (values.has(key)) throw new Error(`Duplicate release argument: ${key}`);
    const value = equal < 0 ? rest[++i] : token.slice(equal + 1);
    if (!value?.trim() || value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
    values.set(key, value);
  }
  return { values, requireReady };
}

export function parseReleaseArgs(args: string[]): ReleaseOptions | undefined {
  if (args.includes('--help') || args.includes('-h')) {
    if (args.length === 1 || (args.length === 2 && ['check', 'prepare'].includes(args[0]!))) return;
    throw new Error('Use --help on its own or after check/prepare.');
  }
  const [command, ...rest] = args;
  if (command !== 'check' && command !== 'prepare') throw new Error(releaseHelp);
  const { values, requireReady } = releaseFlags(rest);
  const minPricingHours = Number(values.get('--min-pricing-hours') ?? '24');
  if (!Number.isFinite(minPricingHours) || minPricingHours < 1 || minPricingHours > 720)
    throw new Error('--min-pricing-hours must be between 1 and 720.');
  if (command === 'prepare' && (!values.has('--out') || !values.has('--distribution')))
    throw new Error('prepare requires --distribution and --out.');
  if (command === 'check' && ['--out', '--distribution', '--smoke-dir'].some((key) => values.has(key)))
    throw new Error('Distribution, smoke reports and output are only accepted by prepare.');
  return {
    command,
    repository: values.get('--repository'),
    securityContact: values.get('--security-contact'),
    minPricingHours,
    requireReady,
    distribution: values.get('--distribution'),
    smokeDir: values.get('--smoke-dir'),
    out: values.get('--out'),
  };
}

export function repositoryUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value.replace(/^git\+/, '').replace(/\.git$/, ''));
    const parts = url.pathname.split('/').filter(Boolean);
    if (
      url.origin !== 'https://github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      parts.length !== 2
    )
      return;
    if (
      parts.some(
        (part) => !/^[A-Za-z0-9_.-]+$/.test(part) || /^(?:owner|repo|example|your[-_].*)$/i.test(part),
      )
    )
      return;
    return `${url.origin}/${parts.join('/')}`;
  } catch {
    return;
  }
}

export function privateContactUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\r\n<>]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return;
    if (
      url.protocol === 'mailto:' &&
      /^[^@\s/?]+@[^@\s/?]+\.[^@\s/?]+$/.test(url.pathname) &&
      !/@(?:example\.(?:com|org|net)|localhost)$/i.test(url.pathname)
    )
      return url.href;
    if (
      url.protocol === 'https:' &&
      url.hostname.includes('.') &&
      !/(^|\.)(?:example\.(?:com|org|net)|localhost)$/.test(url.hostname) &&
      !url.hostname.endsWith('.invalid')
    )
      return url.href;
  } catch {
    /* Invalid or missing configuration becomes a readiness blocker. */
  }
  return;
}

interface CandidateInstallation {
  archive_sha256: string;
  verified_platforms: string[];
  consumer_verified_platforms?: string[];
  consumer_locked_platforms?: string[];
}

function installationBlockers(candidate: CandidateInstallation) {
  const blockers: { code: string; message: string }[] = [];
  for (const platform of platforms) {
    if (!candidate.verified_platforms.includes(platform))
      blockers.push({
        code: 'INSTALL_SMOKE_MISSING',
        message: `The same TGZ needs an installation smoke report for ${platform}.`,
      });
    if (!candidate.consumer_verified_platforms?.includes(platform))
      blockers.push({
        code: 'CONSUMER_SMOKE_MISSING',
        message: `The same TGZ needs an npm consumer smoke report for ${platform}.`,
      });
    else if (!candidate.consumer_locked_platforms?.includes(platform))
      blockers.push({
        code: 'CONSUMER_DEPENDENCY_DRIFT',
        message: `The npm consumer installation for ${platform} must match the reviewed dependency lock.`,
      });
  }
  return blockers;
}

function consumerDrift(candidate?: CandidateInstallation): string[] {
  const verified = candidate?.consumer_verified_platforms ?? [];
  const locked = candidate?.consumer_locked_platforms ?? [];
  return verified.filter((platform) => !locked.includes(platform));
}

export function assessReadiness(input: {
  version: string;
  repository?: string;
  securityContact?: string;
  provenance: Pick<Provenance, (typeof provenanceFields)[number]>;
  pricing: unknown;
  minPricingHours: number;
  nowMs?: number;
  candidate?: CandidateInstallation;
}) {
  const now = input.nowMs ?? Date.now();
  const repository = repositoryUrl(input.repository);
  const securityContact = privateContactUrl(input.securityContact);
  const pricing = pricingSnapshotStatus(input.pricing, now);
  const blockers: { code: string; message: string }[] = [];
  const block = (code: string, message: string) => blockers.push({ code, message });
  if (!repository)
    block(
      'REPOSITORY_UNCONFIGURED',
      'Set the confirmed GitHub repository URL in package.json or --repository.',
    );
  if (!securityContact)
    block(
      'SECURITY_CONTACT_UNCONFIGURED',
      'Set --security-contact to a confirmed private reporting form or mailto address.',
    );
  if (!input.provenance.source_commit || !/^[a-f0-9]{40,64}$/.test(input.provenance.source_commit))
    block('SOURCE_COMMIT_UNKNOWN', 'Prepare the candidate from a Git checkout with an identifiable commit.');
  if (input.provenance.source_dirty !== false)
    block(
      'SOURCE_NOT_CLEAN',
      'Commit the reviewed source changes before preparing a stable release candidate.',
    );
  if (!input.provenance.source_tracked)
    block(
      'SOURCE_NOT_TRACKED',
      'Every public source input must be tracked in this independent Git repository.',
    );
  if (!pricing.usable || (pricing.expires_in_seconds ?? 0) < input.minPricingHours * 3600)
    block(
      'PRICING_REFRESH_REQUIRED',
      `Review and update the bundled pricing evidence; at least ${input.minPricingHours} hours of validity must remain.`,
    );
  if (input.candidate) blockers.push(...installationBlockers(input.candidate));
  return {
    schema_version: 1,
    name: PACKAGE_NAME,
    version: input.version,
    scope: input.candidate ? 'candidate' : 'source',
    ready: blockers.length === 0,
    checked_at: new Date(now).toISOString(),
    repository: repository ?? null,
    security_contact: securityContact ?? null,
    metadata_verified_online: false,
    provenance: input.provenance,
    pricing: { ...pricing, minimum_remaining_hours: input.minPricingHours, evidence_verified_online: false },
    installation: input.candidate ?? null,
    consumer_dependency_drift: consumerDrift(input.candidate),
    blockers,
    publication_performed: false,
    manual_review_required: true,
  };
}

async function regularFile(directory: string, name: string): Promise<Buffer> {
  assertDistributionPath(name);
  if (name.includes('/')) throw new Error('Release inputs must be flat files.');
  const filename = path.join(directory, name);
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Not a regular release file: ${name}`);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error(`Release file changed: ${name}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytes.length !== after.size)
      throw new Error(`Release file changed: ${name}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function verifyDistribution(directory: string, version: string, provenance: Provenance) {
  const names = [
    `ai-modeling-skill-${version}.zip`,
    `ai-modeling-${version}.tgz`,
    'mcp.json',
    'INSTALL.md',
    'manifest.json',
  ];
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.some((entry) => !entry.isFile()) ||
    JSON.stringify(entries.map((entry) => entry.name).sort()) !==
      JSON.stringify([...names, 'SHA256SUMS'].sort())
  )
    throw new Error('A release candidate needs exactly the six all-target export files.');
  const files = new Map<string, Buffer>();
  for (const name of [...names, 'SHA256SUMS']) files.set(name, await regularFile(directory, name));
  const expectedSums =
    names
      .map((name) => `${sha256(files.get(name)!)}  ${name}`)
      .sort()
      .join('\n') + '\n';
  if (files.get('SHA256SUMS')!.toString('utf8') !== expectedSums)
    throw new Error('Distribution SHA256SUMS does not match its files.');
  const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
  if (
    manifest.schema_version !== 2 ||
    manifest.name !== PACKAGE_NAME ||
    manifest.version !== version ||
    manifest.target !== 'all'
  )
    throw new Error('Distribution manifest identity or schema does not match this release.');
  const artifacts = names.filter((name) => name !== 'manifest.json');
  if (
    !Array.isArray(manifest.artifacts) ||
    JSON.stringify(manifest.artifacts.map((entry: { path: string }) => entry.path).sort()) !==
      JSON.stringify(artifacts.sort())
  )
    throw new Error('Distribution artifact inventory does not match this release.');
  for (const artifact of manifest.artifacts) {
    const bytes = files.get(artifact.path)!;
    if (artifact.size !== bytes.length || artifact.sha256 !== sha256(bytes))
      throw new Error('Distribution artifact digest or size mismatch.');
  }
  for (const key of provenanceFields)
    if (manifest.provenance?.[key] !== provenance[key])
      throw new Error(`Distribution provenance differs from this checkout: ${key}`);
  return { archive_sha256: sha256(files.get(`ai-modeling-${version}.tgz`)!) };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function consumerRouteValid(value: unknown): boolean {
  const route = record(value);
  return (
    typeof route.matches === 'boolean' &&
    typeof route.installed_packages === 'number' &&
    Number.isSafeInteger(route.installed_packages) &&
    route.installed_packages > 0 &&
    typeof route.bundled_files_verified === 'number' &&
    Number.isSafeInteger(route.bundled_files_verified) &&
    route.bundled_files_verified >= 0 &&
    Array.isArray(route.mismatches) &&
    route.matches === (route.mismatches.length === 0)
  );
}

function consumerLockValid(value: unknown, expectedDigest?: string): boolean {
  const lock = record(value);
  const routes = lock.routes;
  if (
    typeof lock.matches !== 'boolean' ||
    lock.comparison !== 'name-version-integrity' ||
    typeof lock.production_lock_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(lock.production_lock_sha256) ||
    (expectedDigest !== undefined && lock.production_lock_sha256 !== expectedDigest) ||
    !Array.isArray(routes) ||
    routes.length !== 2
  )
    return false;
  return (
    ['npm-install', 'npx-cache'].every(
      (route) => routes.filter((item) => record(item).route === route).length === 1,
    ) &&
    routes.every(consumerRouteValid) &&
    lock.matches === routes.every((route) => record(route).matches === true)
  );
}

function jsonCredentialProbeValid(value: unknown): boolean {
  const credentials = record(value);
  return (
    credentials.backend === 'json' &&
    credentials.persistence_verified === true &&
    credentials.compare_and_swap_verified === true &&
    credentials.profile_isolation_verified === true &&
    credentials.clear_verified === true &&
    credentials.operator_credentials_accessed === false
  );
}

function globalConsumerValid(value: unknown): boolean {
  const global = record(value);
  const native = record(global.native_runtime);
  const dependencies = record(global.dependency_lock);
  return (
    global.functional_passed === true &&
    native.sharp_encode_decode === true &&
    jsonCredentialProbeValid(global.credential_store) &&
    dependencies.comparison === 'name-version-reviewed-local-bytes' &&
    dependencies.matches === true &&
    typeof dependencies.packages_verified === 'number' &&
    Number.isSafeInteger(dependencies.packages_verified) &&
    dependencies.packages_verified > 0 &&
    typeof dependencies.files_verified === 'number' &&
    Number.isSafeInteger(dependencies.files_verified) &&
    dependencies.files_verified > 0 &&
    typeof global.bundled_files_verified === 'number' &&
    Number.isSafeInteger(global.bundled_files_verified) &&
    global.bundled_files_verified >= 0
  );
}

function reportMatches(
  report: Record<string, unknown>,
  kind: 'smoke' | 'consumer',
  version: string,
  platform: string,
  archiveSha256: string,
): boolean {
  const checks = report.checks;
  const expectedChecks = kind === 'consumer' ? consumerChecks : smokeChecks;
  const method = kind === 'consumer' ? 'npm-install-tgz-and-npx-offline' : 'extracted-tgz-npm-ci-link';
  return (
    report.schema_version === 1 &&
    report.name === PACKAGE_NAME &&
    report.version === version &&
    report.install_method === method &&
    report.platform === platform &&
    report.archive_sha256 === archiveSha256 &&
    report.live_services === false &&
    Array.isArray(checks) &&
    expectedChecks.every((check) => checks.includes(check))
  );
}

export async function readSmokeReports(
  directory: string | undefined,
  version: string,
  archiveSha256: string,
  productionLockSha256?: string,
) {
  const verified: string[] = [];
  const consumerVerified: string[] = [];
  const consumerLocked: string[] = [];
  const reports = new Map<string, Buffer>();
  const result = { verified, consumerVerified, consumerLocked, reports };
  if (!directory) return result;
  const entries = await readdir(directory);
  const accepted = new Set(
    platforms.flatMap((platform) => [`smoke-${platform}.json`, `consumer-${platform}.json`]),
  );
  if (entries.some((name) => !accepted.has(name)))
    throw new Error(
      'Smoke directory may only contain smoke-{linux,darwin,win32}.json and consumer-{linux,darwin,win32}.json.',
    );
  for (const platform of platforms) {
    for (const kind of ['smoke', 'consumer'] as const) {
      const name = `${kind}-${platform}.json`;
      if (!entries.includes(name)) continue;
      const bytes = await regularFile(directory, name);
      const report = record(JSON.parse(bytes.toString('utf8')));
      if (!reportMatches(report, kind, version, platform, archiveSha256))
        throw new Error(
          `${kind === 'consumer' ? 'Consumer' : 'Smoke'} report does not verify this archive: ${name}`,
        );
      if (kind === 'consumer') {
        if (
          report.functional_passed !== true ||
          !consumerLockValid(report.dependency_lock, productionLockSha256) ||
          !globalConsumerValid(report.global_installation)
        )
          throw new Error(`Consumer report does not verify this archive: ${name}`);
        consumerVerified.push(platform);
        if (record(report.dependency_lock).matches === true) consumerLocked.push(platform);
      } else verified.push(platform);
      reports.set(name, bytes);
    }
  }
  return result;
}

function releaseNotes(report: ReturnType<typeof assessReadiness>): string {
  const blockers = report.blockers.length
    ? report.blockers.map((item) => `- ${item.code}: ${item.message}`).join('\n')
    : '- No automated readiness blockers.';
  return `# ai-modeling ${report.version} release candidate\n\nStatus: ${report.ready ? 'ready for maintainer review' : 'blocked'}; this report does not publish or establish publication of the candidate.\n\nSource commit: ${report.provenance.source_commit ?? 'unknown'}.\nRepository: ${report.repository ?? 'unconfigured'}.\nPrivate security contact: ${report.security_contact ?? 'unconfigured'}.\n\n## Readiness\n\n${blockers}\n\nBundled pricing expires: ${report.pricing.expires_at ?? 'unknown'}. At least ${report.pricing.minimum_remaining_hours} hours must remain when preparing the candidate. This check does not reverify pricing evidence online.\n\nTGZ SHA-256: ${report.installation?.archive_sha256 ?? 'unverified'}.\nVerified locked-installation platforms: ${report.installation?.verified_platforms.join(', ') || 'none'}.\nVerified npm consumer platforms: ${report.installation?.consumer_verified_platforms?.join(', ') || 'none'}.\nConsumer dependency drift: ${report.consumer_dependency_drift.join(', ') || 'none recorded'}.\n\nConsumer checks exercise direct TGZ installation, offline npm exec/npx, global installation, MCP discovery and Skill management. Global verification includes real PNG encoding/decoding and an isolated JSON credential save/load/CAS/clear check using synthetic data. Candidate readiness requires functional success, matching name/version/integrity metadata and unchanged bundled files on all three platforms. Reviewed portable dependencies travel in the archive; exact optional platform dependencies are installed by npm.\n\nInstallation checks cover the executable, version, help, CLI/MCP guides, MCP handshake and locked production dependencies. They do not validate a real account, existing user credentials, browser login, Blender, FFmpeg or live Studio behavior.\n\n## Maintainer review and stable publication\n\n1. Review CHANGELOG.md and the user-facing release description before freezing this candidate. Preserve this generated evidence once its identity is frozen.\n2. Confirm the repository and private contact are working, inspect all three locked-installation reports and all three consumer reports for the same TGZ, and confirm full checks plus the production dependency audit passed for this commit.\n3. Before freezing a new candidate, run release:prepare with --require-ready so stale pricing or mismatched files block submission. Review readiness.json and both SHA256SUMS files.\n4. Configure the npm Trusted Publisher for seekskyworld/ai-modeling, release.yml and environment npm. The maintainer completes any required login and 2FA. The release workflow uses Node.js 24 and npm 11.17.0; workflow_dispatch only previews checks.\n5. Publish through the matching version-tag workflow. It freezes the six original distribution files and candidate reports in a draft Release, then persists a submission claim before invoking npm once. Existing claims, including the same run ID, never authorize another upload.\n6. Accepted or unknown submissions retain their original archive and identity. Continue verification without rebuilding or resubmitting, even when registry metadata returns 404. Import legacy processing submission facts before recovery; do not reupload 0.1.3.\n7. Download the exact public npm tarball and match its bytes and registry digests to the frozen TGZ. Only after that verification may the matching draft GitHub Release become public with its original files and checksums.\n8. Generate final notes with scripts/publication-notes.ts from the durable published verification and restored original TGZ. Its pricing update command uses the original source JSON file SHA-256; the canonical pricing digest in readiness.json is not the update-file digest. Preserve the original review and expiry dates.\n9. Verify a clean installation of the exact public version, Skill or MCP setup, and separately authorized live workflows. This candidate command itself never publishes or proves that OIDC or Windows runtime acceptance has completed.\n\n候选包仅供审阅；本命令不会创建稳定 Release、标签或发布到 npm。新提交须通过同一归档的三平台门禁和受控标签工作流；先持久保存提交状态，再单次上传，实际 npm 原包字节验收后才公开 Release。已受理或结果未知时只核对原提交，不重新打包或重传。三平台安装冒烟不代表真实账号、已有用户凭据、浏览器或全部业务能力已验收。\n`;
}

export async function runRelease(root: string, options: ReleaseOptions) {
  const metadata = await readPackageMetadata(root);
  const sourceMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const configuredRepository =
    typeof sourceMetadata.repository === 'string'
      ? sourceMetadata.repository
      : sourceMetadata.repository?.url;
  const provenance = await dependencyProvenance(root);
  const input = {
    version: metadata.version,
    repository: options.repository ?? configuredRepository,
    securityContact: options.securityContact,
    provenance,
    pricing: reviewedPrices,
    minPricingHours: options.minPricingHours,
  };
  if (options.command === 'check') return assessReadiness(input);
  const output = await checkOutput(root, options.out!);
  const distribution = await verifyDistribution(
    path.resolve(options.distribution!),
    metadata.version,
    provenance,
  );
  const smoke = await readSmokeReports(
    options.smokeDir && path.resolve(options.smokeDir),
    metadata.version,
    distribution.archive_sha256,
    provenance.production_lock_sha256,
  );
  const report = assessReadiness({
    ...input,
    candidate: {
      ...distribution,
      verified_platforms: smoke.verified,
      consumer_verified_platforms: smoke.consumerVerified,
      consumer_locked_platforms: smoke.consumerLocked,
    },
  });
  const stage = await mkdtemp(path.join(path.dirname(output), '.ai-modeling-candidate-'));
  try {
    const artifacts = new Map(smoke.reports);
    artifacts.set('readiness.json', Buffer.from(JSON.stringify(report, null, 2) + '\n'));
    artifacts.set('RELEASE.md', Buffer.from(releaseNotes(report)));
    artifacts.set(
      'SHA256SUMS',
      Buffer.from(
        [...artifacts]
          .map(([name, bytes]) => `${sha256(bytes)}  ${name}`)
          .sort()
          .join('\n') + '\n',
      ),
    );
    for (const [name, bytes] of artifacts) await writeFile(path.join(stage, name), bytes, { flag: 'wx' });
    await publishStaged(stage, output, [...artifacts.keys()]);
    return { ...report, output, files: [...artifacts.keys()].sort() };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const options = parseReleaseArgs(process.argv.slice(2));
  if (!options) process.stdout.write(releaseHelp);
  else {
    const result = await runRelease(fileURLToPath(new URL('../', import.meta.url)), options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (options.requireReady && !result.ready) process.exitCode = 1;
  }
}
