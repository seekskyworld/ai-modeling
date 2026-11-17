/** 预览前按原 glTF 动作名选片，避免 Blender 导入器自动选择首个动作或重命名后的名称。 */
import type { Animation, Document } from '@gltf-transform/core';
import { modelIO, removeCompression } from './gltf.ts';
import { readModelInput } from '../../studio/files.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

function animationInfo(animation: Animation, index: number) {
  let start = Infinity,
    end = -Infinity;
  for (const sampler of animation.listSamplers()) {
    const times = sampler.getInput()?.getArray();
    if (!times) continue;
    for (const time of times) {
      start = Math.min(start, time);
      end = Math.max(end, time);
    }
  }
  return {
    index,
    name: animation.getName(),
    start: Number.isFinite(start) ? start : 0,
    duration: Number.isFinite(end - start) ? end - start : 0,
    channels: animation.listChannels().length,
  };
}
function modelInfo(document: Document) {
  const root = document.getRoot();
  return {
    animations: root.listAnimations().map(animationInfo),
    meshes: root
      .listNodes()
      .filter((n) => n.getMesh())
      .map((n) => n.getName()),
    skins: root.listSkins().map((s) => ({ name: s.getName(), joints: s.listJoints().length })),
    textured: root.listMaterials().some((m) => m.getBaseColorTexture() !== null),
  };
}
async function readDocument(bytes: Buffer, format: string) {
  const io = await modelIO();
  const document =
    format === 'glb'
      ? await io.readBinary(bytes)
      : await io.readJSON({ json: JSON.parse(bytes.toString('utf8')), resources: {} });
  removeCompression(document);
  return { io, document };
}
export async function inspectPreviewModel(file: string, roots: string[]) {
  const input = await readModelInput(file, roots);
  if (!['glb', 'gltf'].includes(input.format))
    throw new TripoError('INPUT_FORMAT', 'Preview inspection requires a self-contained GLB/GLTF.');
  const { document } = await readDocument(input.bytes, input.format);
  return { model_sha256: input.sha256, ...modelInfo(document) };
}

export async function preparePreviewModel(bytes: Buffer, format: string, options: Record<string, unknown>) {
  const { io, document } = await readDocument(bytes, format),
    info = modelInfo(document);
  if (['unlit', 'toon'].includes(String(options.display_mode)) && !info.textured)
    throw new TripoError('INPUT_FORMAT', 'Studio unlit/toon modes require a base-color texture.');
  if (options.skeleton && !info.skins.length)
    throw new TripoError('INPUT_FORMAT', 'Skeleton preview requires a skinned model.');
  let animation: ReturnType<typeof animationInfo> | undefined;
  if (typeof options.animation === 'string') {
    const named = info.animations.filter((a) => a.name === options.animation);
    animation =
      named.length === 1
        ? named[0]
        : /^\d+$/.test(options.animation)
          ? info.animations[Number(options.animation)]
          : undefined;
    if (!animation || animation.duration <= 0)
      throw new TripoError(
        'INVALID_INPUT',
        'Animation is missing, ambiguous or empty; use model-inspect to select its index.',
      );
  }
  // 只保留所选片段；未选动作时移除所有动画，使节点与形变权重保持原始绑定状态。
  for (const [index, item] of document.getRoot().listAnimations().entries())
    if (index !== animation?.index) item.dispose();
  return { bytes: Buffer.from(await io.writeBinary(document)), info, animation };
}
