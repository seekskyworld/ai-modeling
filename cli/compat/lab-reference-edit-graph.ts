/** 组合已验证的网页创建/上传/挂载链；每次准备写都先冻结身份，读回原件才允许付费。 */
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Application } from './runtime.ts';
import { object, array, text, TripoError } from '../../studio/contracts/errors.ts';
import { callCanvas, canvasResources } from '../../studio/api/canvas.ts';
import { uploadCanvasFile } from '../../studio/api/canvas-upload.ts';
import { existingArtifact, existingArtifactSchema } from '../../studio/api/existing-artifact.ts';
import { downloadArtifactBytes } from '../artifacts/download.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { labJournalStep, type LabJournal } from './lab-reference-edit-journal.ts';
import {
  labReferenceKey,
  labReferenceFailure,
  type LabReferenceSource,
} from './lab-reference-edit-policy.ts';

export interface LabGraphIO {
  call: (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  upload: (project: string, file: string) => Promise<Record<string, unknown>>;
  bytes: (asset: string, canvas: string, node: string, format: string) => Promise<Buffer>;
  pause: () => Promise<void>;
}
export function labGraphIO(app: Application, source: LabReferenceSource): LabGraphIO {
  const client = app.studio.client.forAccount(app.service.accountRef());
  return {
    call: async (name, input) => {
      const spec = canvasResources.find((r) => r.name === name);
      if (!spec) throw new TripoError('INTERNAL_CONTRACT', `Missing Canvas resource ${name}.`);
      return object(await callCanvas(client, spec, input));
    },
    upload: async (project, file) =>
      object(
        await uploadCanvasFile(
          client,
          project,
          file,
          [
            ...app.service.config.inputRoots,
            path.dirname(source.model.cache_path),
            path.dirname(source.image.cache_path),
          ],
          { wait_seconds: 0 },
        ),
      ),
    bytes: async (asset, canvas, node, format) => {
      const value = await existingArtifact(
        client,
        existingArtifactSchema.parse({
          kind: 'canvas_input',
          id: asset,
          canvas_id: canvas,
          node_id: node,
          destination_path: 'private-validation',
        }),
      );
      return await downloadArtifactBytes(value.url, format);
    },
    pause: async () => {
      await delay(1000);
    },
  };
}
function identifier(value: unknown): string {
  const id = text(value);
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id))
    return labReferenceFailure('Canvas returned an invalid stable identity.');
  return id;
}
function nodePlan(ids: Record<string, unknown>, model: string, image: string) {
  return [
    {
      id: ids.model,
      type: 'NODE_TYPE_UPLOAD_CARD',
      name: 'Original model',
      params: {
        assetType: 'model',
        uploadSource: {
          assetId: model,
          format: 'glb',
          transformMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
      },
      inputMount: [{ assetId: model }],
      ui: { position: { x: 0, y: 0 } },
    },
    {
      id: ids.image,
      type: 'NODE_TYPE_UPLOAD_CARD',
      name: 'Semantic shape reference',
      params: { assetType: 'image' },
      inputMount: [{ assetId: image }],
      ui: { position: { x: 0, y: 300 } },
    },
    {
      id: ids.lab,
      type: 'NODE_TYPE_AI_3D_LAB',
      name: 'Reference-guided region edit',
      params: {},
      ui: { position: { x: 450, y: 150 } },
    },
  ];
}
function graphMatches(actual: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  const expected = array(desired.nodes).map(object),
    nodes = array(actual.nodes).map(object);
  return (
    array(actual.edges).length === 0 &&
    nodes.length === expected.length &&
    expected.every((wanted) => {
      const matches = nodes.filter((n) => n.id === wanted.id),
        found = matches[0];
      if (matches.length !== 1 || found!.type !== wanted.type) return false;
      return (
        fingerprint(object(found!.params)) === fingerprint(object(wanted.params)) &&
        fingerprint(array(found!.inputMount).map((a) => object(a).assetId)) ===
          fingerprint(array(wanted.inputMount).map((a) => object(a).assetId))
      );
    })
  );
}
function checkCanvas(value: Record<string, unknown>, canvas: string, project: string): void {
  const info = object(value.canvas);
  if (info.canvasId !== canvas || info.projectId !== project || !/^\d+$/.test(text(info.revision)))
    return labReferenceFailure('Canvas readback does not match the isolated project identity.');
}
async function waitReadyInputs(
  context: LabJournal,
  io: LabGraphIO,
  project: string,
  modelId: string,
  imageId: string,
): Promise<void> {
  const { parent, check } = context;
  for (let attempt = 0; ; attempt++) {
    const result = await io.call('input_assets', { projectId: project, assetIds: [modelId, imageId] });
    check();
    const assets = array(result.assets).map(object);
    const states = [modelId, imageId].map((id, index) => {
      const found = assets.filter((a) => a.assetId === id);
      if (found.length !== 1 || found[0]!.kind !== (index === 0 ? 'ASSET_KIND_MODEL' : 'ASSET_KIND_IMAGE'))
        return labReferenceFailure('Input status returned a different or ambiguous asset.');
      return text(found[0]!.status);
    });
    if (states.every((s) => s === 'INPUT_ASSET_STATUS_READY')) break;
    if (states.some((s) => s === 'INPUT_ASSET_STATUS_FAILED') || attempt >= 30)
      throw new TripoError(
        'INPUT_NOT_READY',
        'The original registered assets are not ready. Resume this same request; do not upload them again.',
        'read',
        { request_id: parent, asset_ids: [modelId, imageId] },
      );
    await io.pause();
    check();
  }
}
function checkExplicitInputs(
  inputs: Record<string, unknown>,
  canvas: string,
  node: string,
  assetIds: string[],
): void {
  const actual = array(inputs.inputs).map(object);
  // 实际附件接口在 inputs 返回精确 assetId；只接受两个明确绑定，不取“最新”上游。
  if (
    inputs.canvas_id !== canvas ||
    inputs.node_id !== node ||
    inputs.missing === true ||
    array(inputs.missing_inputs).length ||
    array(inputs.missing_asset_ids).length ||
    actual.length !== 2 ||
    fingerprint(inputs.asset_ids) !== fingerprint(assetIds) ||
    !assetIds.every((id) => actual.filter((a) => a.assetId === id || a.asset_id === id).length === 1)
  )
    return labReferenceFailure(
      'Lab explicit input preparation did not preserve both exact asset identities.',
    );
}
export async function prepareLabReferenceGraph(
  context: LabJournal,
  source: LabReferenceSource,
  io: LabGraphIO,
): Promise<Record<string, unknown>> {
  const { jobs, account, parent, check } = context;
  const idsKey = labReferenceKey(parent, 'nodes');
  let ids = jobs.requestPolicy(account, idsKey);
  if (!ids) {
    const proposed = {
      version: 1,
      model: randomUUID(),
      image: randomUUID(),
      lab: randomUUID(),
      client: randomUUID(),
    };
    try {
      jobs.bindRequestPolicy(account, idsKey, proposed);
    } catch (error) {
      if (!jobs.requestPolicy(account, idsKey)) throw error;
    }
    ids = jobs.requestPolicy(account, idsKey)!;
  }
  ['model', 'image', 'lab', 'client'].forEach((key) => identifier(ids![key]));
  const created = await labJournalStep(
    context,
    'create',
    { name: `CLI region edit ${text(ids.client).slice(0, 8)}` },
    async () => {
      const result = await io.call('create', { name: `CLI region edit ${text(ids!.client).slice(0, 8)}` });
      check();
      const project = object(result.project),
        canvas = object(result.canvas);
      if (project.canvasId !== canvas.canvasId || project.projectId !== canvas.projectId)
        return labReferenceFailure(
          'CreateProject did not return one matching project and Canvas; do not create another.',
        );
      return { project_id: identifier(project.projectId), canvas_id: identifier(canvas.canvasId) };
    },
  );
  const project = identifier(created.project_id),
    canvas = identifier(created.canvas_id);
  const upload = async (kind: 'model' | 'image') =>
    await labJournalStep(
      context,
      `upload-${kind}`,
      {
        project_id: project,
        sha256: source[kind].sha256,
        bytes: source[kind].bytes,
        format: source[kind].format,
      },
      async () => {
        const response = await io.upload(project, source[kind].cache_path);
        check();
        const assets = array(response.assets).map(object),
          asset = assets[0];
        if (
          assets.length !== 1 ||
          asset!.kind !== (kind === 'model' ? 'ASSET_KIND_MODEL' : 'ASSET_KIND_IMAGE') ||
          response.uploaded_sha256 !== source[kind].sha256 ||
          response.uploaded_format !== source[kind].format
        )
          return labReferenceFailure(
            'Canvas accepted input does not match the frozen source; its registration is not repeated.',
          );
        return {
          asset_id: identifier(asset!.assetId),
          kind: asset!.kind,
          sha256: response.uploaded_sha256,
          format: response.uploaded_format,
        };
      },
    );
  const model = await upload('model'),
    image = await upload('image');
  check();
  const modelId = identifier(model.asset_id),
    imageId = identifier(image.asset_id);
  await waitReadyInputs(context, io, project, modelId, imageId);
  const current = await io.call('get', { canvasId: canvas });
  check();
  checkCanvas(current, canvas, project);
  const previousStart = jobs.requestPolicy(account, labReferenceKey(parent, 'save:start'));
  const desired = previousStart
    ? object(previousStart.parameters)
    : {
        canvasId: canvas,
        projectId: project,
        revision: text(object(current.canvas).revision),
        clientId: ids.client,
        nodes: nodePlan(ids, modelId, imageId),
        edges: [],
      };
  if (!previousStart && (array(current.nodes).length || array(current.edges).length))
    throw new TripoError(
      'CANVAS_CHANGED',
      'The isolated Canvas was changed before the reference graph was saved; existing nodes will not be overwritten.',
      'not_submitted',
    );
  await labJournalStep(
    context,
    'save',
    desired,
    async () => {
      const result = await io.call('save', desired);
      check();
      if (!/^\d+$/.test(text(result.revision)) || array(result.violations).length)
        return labReferenceFailure('Canvas save has no successful revision receipt.');
      return { revision: result.revision };
    },
    async () => {
      const readback = await io.call('get', { canvasId: canvas });
      check();
      checkCanvas(readback, canvas, project);
      return graphMatches(readback, desired) &&
        BigInt(text(object(readback.canvas).revision)) === BigInt(text(desired.revision)) + 1n
        ? { revision: object(readback.canvas).revision }
        : undefined;
    },
  );
  const saved = await io.call('get', { canvasId: canvas });
  check();
  checkCanvas(saved, canvas, project);
  if (!graphMatches(saved, desired))
    return labReferenceFailure(
      'The original saved Lab nodes or input bindings changed; do not overwrite the Canvas.',
    );
  const binding = {
    version: 1,
    project_id: project,
    canvas_id: canvas,
    model_node_id: ids.model,
    image_node_id: ids.image,
    lab_node_id: ids.lab,
    model_asset_id: modelId,
    image_asset_id: imageId,
  };
  jobs.bindRequestPolicy(account, labReferenceKey(parent, 'graph'), binding);
  const registeredKey = labReferenceKey(parent, 'registered');
  if (!jobs.requestPolicy(account, registeredKey)) {
    const modelBytes = await io.bytes(modelId, canvas, text(ids.model), 'glb');
    check();
    const imageBytes = await io.bytes(imageId, canvas, text(ids.image), 'image');
    check();
    const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    if (
      digest(modelBytes) !== source.model.sha256 ||
      modelBytes.length !== source.model.bytes ||
      digest(imageBytes) !== source.image.sha256 ||
      imageBytes.length !== source.image.bytes
    )
      return labReferenceFailure(
        'Registered Canvas attachment bytes differ from the exact original inputs. No Lab job was started.',
      );
    jobs.bindRequestPolicy(account, registeredKey, {
      version: 1,
      graph: fingerprint(binding),
      model_sha256: source.model.sha256,
      image_sha256: source.image.sha256,
    });
  }
  const inputs = await io.call('lab_inputs', {
    canvasId: canvas,
    nodeId: ids.lab,
    assetIds: [modelId, imageId],
  });
  check();
  checkExplicitInputs(inputs, canvas, text(ids.lab), [modelId, imageId]);
  return binding;
}
