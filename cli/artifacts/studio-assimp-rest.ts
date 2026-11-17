/** 原引擎会省略很小的默认TRS；从原模型逐值恢复原节点及新增常量轨道，不拟合/改写原动作轨道。 */
import {
  Logger,
  type Animation,
  type AnimationChannel,
  type AnimationSampler,
  type Document,
  type Node,
} from '@gltf-transform/core';
import { modelIO } from '../local/gltf.ts';
import { frontendFail as fail, readFrontendDocument } from './studio-assimp-normalize.ts';
import { preserveSourceNodeTrs, preserveFrontendAssetAigc } from './studio-assimp-json.ts';

const equal = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const key = (channel: AnimationChannel): string =>
  `${channel.getTargetNode()?.getName()}\0${channel.getTargetPath()}`;
function restoreNode(source: Node, target: Node): boolean {
  if (
    equal(source.getTranslation(), target.getTranslation()) &&
    equal(source.getRotation(), target.getRotation()) &&
    equal(source.getScale(), target.getScale())
  )
    return false;
  target
    .setTranslation(source.getTranslation())
    .setRotation(source.getRotation())
    .setScale(source.getScale());
  return true;
}
function replaceSampler(channel: AnimationChannel, animation: Animation, next: AnimationSampler): void {
  const previous = channel.getSampler();
  animation.addSampler(next);
  channel.setSampler(next);
  if (previous && !animation.listChannels().some((other) => other.getSampler() === previous))
    animation.removeSampler(previous);
}
function restoreConstant(channel: AnimationChannel, node: Node, animation: Animation): boolean {
  const path = channel.getTargetPath(),
    sampler = channel.getSampler(),
    accessor = sampler?.getOutput();
  if (!sampler || !accessor || !['translation', 'rotation', 'scale'].includes(path ?? ''))
    return fail('Unexpected added animation channel.');
  const first = accessor.getElement(0, []);
  for (let i = 1; i < accessor.getCount(); i++)
    if (!equal(first, accessor.getElement(i, []))) return fail('An added engine track is not constant.');
  const expected =
    path === 'rotation'
      ? node.getRotation()
      : path === 'translation'
        ? node.getTranslation()
        : node.getScale();
  if (first.length !== expected.length) return fail('Added engine track has a wrong value shape.');
  if (equal(first, expected)) return false;
  // 先拒绝非恒定/非有限数据；只将新增常量轨道明确设为原文件已给定的rest值。
  const data = new Float32Array(accessor.getCount() * expected.length);
  for (let i = 0; i < accessor.getCount(); i++) data.set(expected, i * expected.length);
  const replacement = sampler.clone().setOutput(accessor.clone().setArray(data).setNormalized(false));
  replaceSampler(channel, animation, replacement);
  return true;
}
/** 原引擎只保留三次样条的关键值；时间/关键值吻合后逐字复制原切线，禁止拟合曲线。 */
function restoreCubic(
  original: AnimationSampler,
  channel: AnimationChannel,
  animation: Animation,
  document: Document,
): boolean {
  const target = channel.getSampler()!;
  if (original.getInterpolation() !== 'CUBICSPLINE' || target.getInterpolation() === 'CUBICSPLINE')
    return false;
  const time = original.getInput(),
    values = original.getOutput(),
    targetTime = target.getInput(),
    targetValues = target.getOutput();
  if (
    target.getInterpolation() !== 'LINEAR' ||
    !time ||
    !values ||
    !targetTime ||
    !targetValues ||
    time.getCount() !== targetTime.getCount() ||
    values.getCount() !== time.getCount() * 3 ||
    targetValues.getCount() !== time.getCount() ||
    values.getType() !== targetValues.getType()
  )
    return fail('The engine did not preserve the cubic animation keyframe layout.');
  for (let i = 0; i < time.getCount(); i++) {
    if (time.getScalar(i) !== targetTime.getScalar(i))
      return fail('The engine changed a cubic animation keyframe time.');
    const expected = values.getElement(i * 3 + 1, []),
      actual = targetValues.getElement(i, []);
    if (expected.some((v, index) => Math.abs(v - actual[index]!) > 2e-6))
      return fail('The engine changed a cubic animation keyframe value.');
  }
  const restored = document
    .createAccessor(values.getName())
    .setType(values.getType())
    .setArray(values.getArray()!.slice())
    .setNormalized(values.getNormalized())
    .setBuffer(document.getRoot().listBuffers()[0]!);
  replaceSampler(channel, animation, target.clone().setInterpolation('CUBICSPLINE').setOutput(restored));
  return true;
}
function restoreAnimation(
  original: Animation | undefined,
  animation: Animation,
  named: Map<string, Node>,
  document: Document,
): { tracks: number; interpolations: number; cubicTracks: number } {
  if (!original) return fail('The engine introduced an animation clip.');
  const originalChannels = new Map(original.listChannels().map((channel) => [key(channel), channel]));
  const counts = { tracks: 0, interpolations: 0, cubicTracks: 0 };
  for (const channel of animation.listChannels()) {
    const originalChannel = originalChannels.get(key(channel));
    if (originalChannel) {
      const from = originalChannel.getSampler(),
        to = channel.getSampler();
      if (from && to && restoreCubic(from, channel, animation, document)) {
        counts.cubicTracks++;
        continue;
      }
      if (from && to && from.getInterpolation() !== to.getInterpolation()) {
        replaceSampler(channel, animation, to.clone().setInterpolation(from.getInterpolation()));
        counts.interpolations++;
      }
      continue;
    }
    const originalNode = named.get(channel.getTargetNode()?.getName() ?? '');
    if (!originalNode) return fail('The engine added a channel for a new node.');
    if (restoreConstant(channel, originalNode, animation)) counts.tracks++;
  }
  return counts;
}
export async function restoreFrontendDefaults(
  sourceBytes: Buffer,
  outputBytes: Buffer,
): Promise<{ bytes: Buffer; proof: Record<string, unknown> }> {
  const attributed = preserveFrontendAssetAigc(sourceBytes, outputBytes),
    restoredAsset = attributed !== outputBytes;
  outputBytes = attributed;
  const source = (await readFrontendDocument(sourceBytes)).getRoot(),
    document = await readFrontendDocument(outputBytes, true),
    target = document.getRoot();
  if (!source.listSkins().length && !source.listAnimations().length)
    return {
      bytes: outputBytes,
      proof: {
        restored_nodes: 0,
        restored_constant_tracks: 0,
        ...(restoredAsset ? { restored_asset_aigc: true } : {}),
      },
    };
  const named = new Map(source.listNodes().map((node) => [node.getName(), node]));
  let restoredNodes = 0,
    restoredTracks = 0,
    restoredInterpolations = 0,
    restoredCubicTracks = 0;
  for (const node of target.listNodes()) {
    const original = named.get(node.getName());
    if (original && restoreNode(original, node)) restoredNodes++;
  }
  for (const animation of target.listAnimations()) {
    const original = source.listAnimations().find((x) => x.getName() === animation.getName()),
      counts = restoreAnimation(original, animation, named, document);
    restoredTracks += counts.tracks;
    restoredInterpolations += counts.interpolations;
    restoredCubicTracks += counts.cubicTracks;
  }
  if (!restoredNodes && !restoredTracks && !restoredInterpolations && !restoredCubicTracks)
    return {
      bytes: outputBytes,
      proof: {
        restored_nodes: 0,
        restored_constant_tracks: 0,
        ...(restoredAsset ? { restored_asset_aigc: true } : {}),
      },
    };
  const io = (await modelIO()).setLogger(new Logger(Logger.Verbosity.SILENT));
  return {
    bytes: preserveSourceNodeTrs(sourceBytes, Buffer.from(await io.writeBinary(document))),
    proof: {
      restored_nodes: restoredNodes,
      restored_constant_tracks: restoredTracks,
      restored_interpolations: restoredInterpolations,
      ...(restoredCubicTracks ? { restored_cubic_tracks: restoredCubicTracks } : {}),
      ...(restoredAsset ? { restored_asset_aigc: true } : {}),
      method:
        'Copy original node TRS, interpolation enums and rest values into engine-added constant tracks; restore original cubic tangents only after exact keyframe time/value correspondence, without curve fitting.',
    },
  };
}
