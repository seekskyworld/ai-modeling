/** Only the test loader replaces application construction; real CLI/schema/planner/service execute. */
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, quote } from './helpers.ts';
import { uvImportFixture } from './uv-import-fixture.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import type { Job, RemoteStatus } from '../studio/contracts/types.ts';

const self = import.meta.url;
const application = new URL('../cli/core/application.ts', self).href;
const record = (value: Record<string, unknown>) =>
  appendFileSync(process.env.UNQUOTED_FULL_TRACE!, JSON.stringify(value) + '\n');
registerHooks({
  load(url, context, next) {
    if (url === application)
      return {
        format: 'module',
        shortCircuit: true,
        source: `export { createApplication } from ${JSON.stringify(self)};`,
      };
    return next(url, context);
  },
});
globalThis.fetch = async () => {
  throw Error('The full MCP regression cannot use real network.');
};
record({ kind: 'cli-process', arguments: process.argv.slice(2) });

export async function createApplication() {
  const f = await fixture(process.env.AI_MODELING_DATA_DIR);
  const original = await uvImportFixture(false),
    native = await uvImportFixture(true);
  const sourcePath = path.join(f.dir, 'original.glb'),
    nativePath = path.join(f.dir, 'compressed.glb');
  await writeFile(sourcePath, original);
  await writeFile(nativePath, native);
  const artifact = (bytes: Buffer, file: string) => ({
    artifact_id: 'model',
    kind: 'model' as const,
    format: 'glb',
    index: 0,
    local_path: file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  });
  let source = f.jobs.find('test-account', 'full-unquoted-source');
  if (!source) {
    source = f.jobs.prepare(
      'test-account',
      'full-unquoted-source',
      'uv_commit',
      normalize('uv_commit', {
        project_id: 'project',
        current_operator_id: 'base',
        candidate_operator_id: 'candidate',
      }),
      quote,
    );
    source = f.jobs.update(source.job_id, 'succeeded', {
      remote_ids: { project_id: 'project', operator_id: 'applied' },
      artifacts: [artifact(original, sourcePath)],
    });
    f.jobs.assignName('test-account', 'unquoted-source', source.job_id);
  }
  f.service.pricing.quote = async (operation) => {
    record({ kind: 'quote', operation });
    return operation === 'import_model'
      ? { ...quote, known: false, credits: undefined, variable: true }
      : quote;
  };
  const submit = f.service.submit.bind(f.service);
  f.service.submit = async (operation, request, parameters, maximum) => {
    record({
      kind: 'service-submit',
      operation,
      request,
      maximum_absent: maximum === undefined,
      maximum,
      parameters,
    });
    return await submit(operation, request, parameters, maximum);
  };
  const status = (job: Job): RemoteStatus => ({
    state: 'succeeded',
    progress: 100,
    artifacts:
      job.operation === 'uv_generate'
        ? []
        : [job.operation === 'import_model' ? artifact(native, nativePath) : artifact(original, sourcePath)],
  });
  f.gateway.submit = async (job) => {
    record({ kind: 'remote-submit', operation: job.operation, request: job.request_id });
    f.gateway.posts++;
    return {
      remote_ids: {
        project_id: job.operation === 'import_model' ? 'imported' : 'project',
        operator_id: job.operation,
      },
      status: status(job),
    };
  };
  f.gateway.status = async (job) => status(job);
  f.gateway.account = async () => {
    record({ kind: 'remote-account' });
    return { authenticated: true, balance: 100, account_ref: 'test-account' };
  };
  return {
    service: f.service,
    studio: {
      assets: async () => ({}),
      client: {
        request: async () => {
          throw Error('Unexpected Studio read.');
        },
      },
    },
    close: () => f.jobs.close(),
  };
}
