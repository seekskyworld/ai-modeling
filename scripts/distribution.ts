/** Assemble releases with locked npm dependencies; never import credentials or business services. */
import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { PACKAGE_NAME } from '../version.ts';
import { checkDocumentation } from './documentation-check.ts';
import { createZip, type ZipEntry } from './distribution-zip.ts';
import {
  dependencyProvenance,
  unbundledRuntimeLocation,
  provenanceFields,
  readProductionLock,
} from './dependency-lock.ts';
import {
  assertPackageFile,
  assertPublicFile,
  assertUniquePaths,
  packageInventory,
  parsePackResult,
  readDistributionFile,
  readPackageMetadata,
  runNpm,
  validatePackageInventory,
  type PackResult,
} from './package-validation.ts';

export type ExportTarget = 'all' | 'skill' | 'mcp';
export interface ExportOptions {
  out: string;
  target: ExportTarget;
}
interface Artifact {
  path: string;
  kind: 'skill' | 'npm-package' | 'mcp-config' | 'instructions';
  size: number;
  sha256: string;
}

export const exportHelp = `Usage: npm run export -- --out DIR [--target all|skill|mcp]

Export the current version. Runtime exports prepare locked dependencies in a temporary directory.
No account access or publication.

  --out DIR       Required new directory outside the source tree; parent must exist.
  --target TARGET all (default), skill, or mcp. MCP always builds the current source.
  --help, -h      Show this help without building or creating files.

Skill: ai-modeling-skill-VERSION.zip, containing ai-modeling/SKILL.md and LICENSE.
MCP:   ai-modeling-VERSION.tgz and mcp.json for an installed runtime.
Each export includes INSTALL.md, manifest.json and SHA256SUMS.
Existing output paths are never replaced; there is no --force option.
`;

export function parseExportArgs(args: string[]): ExportOptions | undefined {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return;
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const separator = token.indexOf('=');
    const key = separator < 0 ? token : token.slice(0, separator);
    if (key !== '--out' && key !== '--target') throw new Error(`Unknown export argument: ${token}`);
    if (values.has(key)) throw new Error(`Duplicate export argument: ${key}`);
    const value = separator < 0 ? args[++i] : token.slice(separator + 1);
    if (!value || value.startsWith('--') || value === '-h') throw new Error(`Missing value for ${key}.`);
    values.set(key, value);
  }
  const out = values.get('--out');
  if (!out?.trim()) throw new Error('--out is required. Use --help for usage.');
  const target = values.get('--target') ?? 'all';
  if (target !== 'all' && target !== 'skill' && target !== 'mcp')
    throw new Error('--target must be all, skill, or mcp.');
  return { out, target };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

export async function checkOutput(root: string, selected: string): Promise<string> {
  const requested = path.resolve(selected);
  const parent = await realpath(path.dirname(requested));
  const output = path.join(parent, path.basename(requested));
  const entry = await lstat(parent);
  if (!entry.isDirectory()) throw new Error('The output parent must be an existing directory.');
  const source = await realpath(root);
  if (output === source || output.startsWith(source + path.sep))
    throw new Error('The output directory must be outside the source repository.');
  try {
    await lstat(output);
    throw new Error('Output path already exists; choose a new directory.');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return output;
}

async function skillTree(root: string, directory = 'skills/ai-modeling'): Promise<string[]> {
  const info = await lstat(path.join(root, directory));
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Skill source must be a real directory.');
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    assertPublicFile(file);
    if (entry.isDirectory()) result.push(...(await skillTree(root, file)));
    else if (entry.isFile()) result.push(file);
    else throw new Error(`Skill input must be a regular file or directory: ${file}`);
  }
  return result.sort();
}

async function makeSkill(root: string, stage: string, version: string): Promise<string> {
  const files = await skillTree(root);
  if (!files.includes('skills/ai-modeling/SKILL.md')) throw new Error('Missing skills/ai-modeling/SKILL.md.');
  const projected = files.map((file) => file.slice('skills/ai-modeling/'.length));
  assertUniquePaths([...projected, 'LICENSE']);
  const snapshot = path.join(stage, 'skill-source');
  await mkdir(snapshot);
  const entries: ZipEntry[] = [];
  for (const [index, file] of files.entries()) {
    const relative = projected[index]!;
    const bytes = await readDistributionFile(root, file);
    const mode = (await lstat(path.join(root, file))).mode;
    await mkdir(path.dirname(path.join(snapshot, relative)), { recursive: true });
    await writeFile(path.join(snapshot, relative), bytes, { flag: 'wx' });
    entries.push({ path: `ai-modeling/${relative}`, bytes, executable: Boolean(mode & 0o111) });
  }
  const license = await readDistributionFile(root, 'LICENSE');
  await writeFile(path.join(snapshot, 'LICENSE'), license, { flag: 'wx' });
  const docs = await checkDocumentation(snapshot, [...projected, 'LICENSE']);
  if (docs.errors.length) throw new Error(docs.errors.join('\n'));
  entries.push({ path: 'ai-modeling/LICENSE', bytes: license });
  const filename = `ai-modeling-skill-${version}.zip`;
  await writeFile(path.join(stage, filename), createZip(entries), { flag: 'wx' });
  await rm(snapshot, { recursive: true });
  return filename;
}

async function snapshotPackage(root: string, stage: string, inventory: PackResult): Promise<string> {
  assertUniquePaths(inventory.files.map((entry) => entry.path));
  const snapshot = path.join(stage, 'runtime-source');
  await mkdir(snapshot);
  for (const entry of inventory.files) {
    assertPackageFile(entry.path);
    const bytes = await readDistributionFile(root, entry.path);
    if (bytes.length !== entry.size) throw new Error(`Package source changed: ${entry.path}`);
    const file = path.join(snapshot, entry.path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: 'wx', mode: (entry.mode ?? 0o644) & 0o777 });
  }
  await validatePackageInventory(snapshot, inventory);
  return snapshot;
}

function sameInventory(before: PackResult, after: PackResult): boolean {
  const files = (value: PackResult) => value.files.map((file) => `${file.path}\0${file.size}`).sort();
  return (
    before.name === after.name &&
    before.version === after.version &&
    JSON.stringify(files(before)) === JSON.stringify(files(after))
  );
}

async function makeRuntime(root: string, stage: string, version: string, npmCli?: string): Promise<string> {
  runNpm(root, ['run', 'build'], npmCli);
  const inventory = packageInventory(root, npmCli);
  const snapshot = await snapshotPackage(root, stage, inventory);
  const { lock } = await readProductionLock(root);
  await writeFile(path.join(snapshot, 'npm-shrinkwrap.json'), JSON.stringify(lock, null, 2) + '\n', {
    flag: 'wx',
  });
  const runtimeMetadata = JSON.parse(await readFile(path.join(snapshot, 'package.json'), 'utf8'));
  delete runtimeMetadata.devDependencies;
  runtimeMetadata.dependencies = lock.packages['']!.dependencies;
  runtimeMetadata.optionalDependencies = lock.packages['']!.optionalDependencies;
  runtimeMetadata.bundleDependencies = lock.packages['']!.bundleDependencies;
  await writeFile(path.join(snapshot, 'package.json'), JSON.stringify(runtimeMetadata, null, 2) + '\n');
  if (runtimeMetadata.bundleDependencies?.length) {
    // Build this tree from the integrity-checked lock, never copy a developer's node_modules.
    runNpm(snapshot, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], npmCli);
    for (const location of Object.keys(lock.packages))
      if (location && unbundledRuntimeLocation(lock, location))
        await rm(path.join(snapshot, location), { recursive: true, force: true });
    await rm(path.join(snapshot, 'node_modules/.package-lock.json'), { force: true });
  }
  const lockedInventory = packageInventory(snapshot, npmCli);
  await validatePackageInventory(snapshot, lockedInventory);
  if (!lockedInventory.files.some((entry) => entry.path === 'npm-shrinkwrap.json'))
    throw new Error('The runtime package must include its generated production shrinkwrap.');
  await validatePackageInventory(snapshot, lockedInventory);
  const packed = parsePackResult(
    runNpm(snapshot, ['pack', '--ignore-scripts', '--json', '--pack-destination', stage], npmCli),
  );
  const filename = `ai-modeling-${version}.tgz`;
  const npmFilename = `${PACKAGE_NAME.slice(1).replace('/', '-')}-${version}.tgz`;
  if (packed.filename !== npmFilename || !sameInventory(lockedInventory, packed))
    throw new Error('Packed archive does not match the validated package inventory.');
  await rename(path.join(stage, npmFilename), path.join(stage, filename));
  const example = await readDistributionFile(snapshot, 'examples/mcp-installed.json');
  JSON.parse(example.toString('utf8'));
  await writeFile(path.join(stage, 'mcp.json'), example, { flag: 'wx' });
  await rm(snapshot, { recursive: true });
  return filename;
}

function installGuide(version: string, target: ExportTarget): string {
  const lines = [
    '# ai-modeling installation',
    '',
    `Version: ${version}. Selected export: ${target}.`,
    '',
    'Verify the files against SHA256SUMS before installation. manifest.json describes the selected artifacts.',
    'This export does not configure an agent, log in, submit tasks, or publish packages.',
    '',
  ];
  if (target !== 'skill')
    lines.push(
      '## CLI and MCP runtime',
      '',
      'Install Node.js 24+ and npm. Install the scoped public package:',
      '',
      '```sh',
      `npm install --global @seekskyworld/ai-modeling@${version}`,
      'ai-modeling --version',
      'ai-modeling setup',
      '```',
      '',
      'Alternatively, use this reviewed archive with a persistent local installation:',
      '',
      '```sh',
      `mkdir ../ai-modeling-runtime-${version}`,
      `tar -xzf ./ai-modeling-${version}.tgz -C ../ai-modeling-runtime-${version} --strip-components=1`,
      `cd ../ai-modeling-runtime-${version}`,
      'npm ci --omit=dev --no-audit --no-fund',
      'npm link --omit=dev --ignore-scripts',
      'ai-modeling --version',
      'ai-modeling setup',
      '```',
      '',
      'Choose a new persistent runtime directory; stop and choose another name if it already exists. The linked command points into that directory, so keep it in place. npm ci installs the production graph from npm-shrinkwrap.json and may need internet access; keep platform optional dependencies enabled. The exported package omits development dependencies. The exported package bundles reviewed portable runtime dependencies. Exact optional platform packages are installed by npm; do not omit optional dependencies.',
      'Use a compatible system credential store and Chrome/Edge for browser login. The only executable is ai-modeling; start MCP with ai-modeling mcp. Use --toolset studio only when broader Studio tools are needed.',
      'For MCP, import the contents of mcp.json into your client using its native configuration format. The command ai-modeling must be available on the client process PATH; keep mcp as the first argument. Otherwise set command to its installed absolute executable path. Do not point it at this export folder.',
      'Use the same OS user and profile as the CLI. MCP communicates over stdio and has no web console. Never put account tokens or cookies into MCP configuration.',
      'MCP provides ai-modeling://guides/usage, ai-modeling://guides/commands and ai-modeling://guides/pipelines alongside tools that invoke CLI internally. CLI users can read the same guidance with ai-modeling guides list and ai-modeling guides read usage.',
      'For Skill installation, run ai-modeling skill targets to list documented client directories, then choose a target explicitly, for example ai-modeling skill install --target claude-code. No client is selected by default. Use --scope project --project-dir /path/to/project for a project installation; other targets default to user scope, while golutra-agent only supports project scope and defaults to it. Use --dir /path/to/skills alone for any custom skills parent directory. Repeat the same selection with skill status or skill uninstall. npm installation does not install the Skill into a client automatically. Managed updates and removal refuse user-modified or unmanaged contents.',
      'The runtime includes examples for common mcpServers JSON, Codex TOML, OpenCode JSON, and the VS Code Local configuration. For Golutra Agent, ai-modeling mcp export --target golutra-agent --out /path/to/new-plugin-export prepares native manifests, but host 0.3.9 filters MCP tools from its model surface even after stage/review/enable. Use its project Skill/CLI route or revalidate MCP after a host fix; export does not prove calls work. Choose the format documented by your client version. Installed files and valid configuration do not prove client discovery; reload the client and verify the Skill or MCP tools there.',
      '',
    );
  if (target !== 'mcp')
    lines.push(
      '## Agent Skill',
      '',
      `Extract ai-modeling-skill-${version}.zip. Install the enclosed ai-modeling/ folder through your agent's Skill importer or its configured skills directory.`,
      'Keep SKILL.md, references, LICENSE and NOTICE together. The archive contains instructions, not a CLI binary or credentials.',
      'CLI is the underlying execution interface. MCP provides shared guidance and tools that invoke CLI internally; agents using MCP stay with its resources and tools. The Skill progressively loads instructions, examples and workflow guidance, using CLI by default and preserving a chosen MCP interface.',
      target === 'skill'
        ? 'Install the matching CLI runtime separately from a trusted ai-modeling source or MCP/runtime export before using the Skill.'
        : 'Install the CLI runtime above before using the Skill; a separate MCP server is optional.',
      '',
    );
  lines.push(
    '## Account and usage',
    '',
    'The CLI and MCP use your own Tripo Studio web account and web credits, not the developer API wallet.',
    'Configure AI_MODELING_* environment variables. Older command, tool, resource and configuration names are not aliases; update client settings and log in again under the new namespace.',
    'Complete passwords, verification codes and second-factor prompts yourself. A Skill does not grant access to an account.',
    'Generation and some editing steps spend Studio credits. Inspect the command help and quote before submitting; preserve the original request identity when recovering uncertain results.',
    'Blender/FFmpeg and restricted web conversion runtimes are optional for specific operations and are not bundled here.',
    'The code and Skill use Apache-2.0; external services and resources keep their own licenses and access conditions.',
    '',
  );
  return lines.join('\n');
}

async function describeArtifact(stage: string, filename: string, kind: Artifact['kind']): Promise<Artifact> {
  const bytes = await readFile(path.join(stage, filename));
  return {
    path: filename,
    kind,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function metadataFiles(
  stage: string,
  version: string,
  target: ExportTarget,
  artifacts: Artifact[],
  provenance: Awaited<ReturnType<typeof dependencyProvenance>>,
): Promise<string[]> {
  await writeFile(path.join(stage, 'INSTALL.md'), installGuide(version, target), { flag: 'wx' });
  artifacts.push(await describeArtifact(stage, 'INSTALL.md', 'instructions'));
  const manifest = { schema_version: 2, name: PACKAGE_NAME, version, target, provenance, artifacts };
  await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  const manifestBytes = await readFile(path.join(stage, 'manifest.json'));
  const sums = artifacts.map((file) => `${file.sha256}  ${file.path}`);
  sums.push(`${createHash('sha256').update(manifestBytes).digest('hex')}  manifest.json`);
  await writeFile(path.join(stage, 'SHA256SUMS'), sums.sort().join('\n') + '\n', { flag: 'wx' });
  return [...artifacts.map((file) => file.path), 'manifest.json', 'SHA256SUMS'].sort();
}

/** Reserve the destination atomically, then publish files without overwriting any existing name. */
export async function publishStaged(stage: string, output: string, files: string[]): Promise<void> {
  assertUniquePaths(files);
  if (files.some((file) => file.includes('/'))) throw new Error('Published artifacts must be flat files.');
  await mkdir(output);
  const owned = await lstat(output);
  const linked: { name: string; dev: number; ino: number }[] = [];
  const sameDirectory = async () => {
    const current = await lstat(output).catch(() => undefined);
    return current?.isDirectory() && current.dev === owned.dev && current.ino === owned.ino;
  };
  try {
    for (const name of files) {
      if (!(await sameDirectory())) throw new Error('Output directory changed during publication.');
      const source = await lstat(path.join(stage, name));
      if (!source.isFile() || source.isSymbolicLink())
        throw new Error('Staged artifact must be a regular file.');
      await link(path.join(stage, name), path.join(output, name));
      linked.push({ name, dev: source.dev, ino: source.ino });
    }
  } catch (error) {
    if (await sameDirectory()) {
      for (const entry of linked) {
        const file = path.join(output, entry.name);
        const current = await lstat(file).catch(() => undefined);
        if (current?.dev === entry.dev && current.ino === entry.ino) await unlink(file);
      }
      await rmdir(output).catch(() => undefined); // Preserve concurrently added unrelated files.
    }
    throw error;
  }
}

export async function exportDistribution(root: string, options: ExportOptions, npmCli?: string) {
  if (!options.out || !['all', 'skill', 'mcp'].includes(options.target))
    throw new Error('Invalid export options.');
  const output = await checkOutput(root, options.out);
  const metadata = await readPackageMetadata(root);
  const provenance = await dependencyProvenance(root, npmCli);
  const stage = await mkdtemp(path.join(path.dirname(output), '.ai-modeling-export-'));
  try {
    const artifacts: Artifact[] = [];
    if (options.target !== 'mcp') {
      const filename = await makeSkill(root, stage, metadata.version);
      artifacts.push(await describeArtifact(stage, filename, 'skill'));
    }
    if (options.target !== 'skill') {
      const filename = await makeRuntime(root, stage, metadata.version, npmCli);
      artifacts.push(await describeArtifact(stage, filename, 'npm-package'));
      artifacts.push(await describeArtifact(stage, 'mcp.json', 'mcp-config'));
    }
    const after = await dependencyProvenance(root, npmCli);
    if (provenanceFields.some((key) => provenance[key] !== after[key]))
      throw new Error('Source or dependency provenance changed during export.');
    const files = await metadataFiles(stage, metadata.version, options.target, artifacts, provenance);
    await publishStaged(stage, output, files);
    return { output, version: metadata.version, target: options.target, files };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
