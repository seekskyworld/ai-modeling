/** 对应网页 getVertexPosition：在文件保存的节点/骨骼姿态下评估 morph 和蒙皮，不采样动画轨道。 */
import type { Node, Primitive } from '@gltf-transform/core';
import { mat4, vec3 } from 'gl-matrix';
import { TripoError } from '../../studio/contracts/errors.ts';

export function uvPositionReader(node: Node, primitive: Primitive): (index: number) => vec3 {
  const position = primitive.getAttribute('POSITION')!;
  const weights = node.getWeights().length ? node.getWeights() : (node.getMesh()?.getWeights() ?? []);
  const targets = primitive.listTargets().map((target) => target.getAttribute('POSITION'));
  const skin = node.getSkin(),
    world = node.getWorldMatrix();
  const joints = skin
    ?.listJoints()
    .map((joint, index) =>
      mat4.multiply(
        mat4.create(),
        joint.getWorldMatrix(),
        skin.getInverseBindMatrices()?.getElement(index, []) ?? mat4.create(),
      ),
    );
  const influences = [0, 1]
    .map((set) => ({
      indices: primitive.getAttribute(`JOINTS_${set}`),
      weights: primitive.getAttribute(`WEIGHTS_${set}`),
    }))
    .filter((set) => set.indices || set.weights);
  if (
    skin &&
    (!influences.length ||
      influences.some(
        (set) =>
          !set.indices ||
          !set.weights ||
          set.indices.getCount() !== position.getCount() ||
          set.weights.getCount() !== position.getCount(),
      ))
  )
    throw new TripoError('UV_TOPOLOGY', 'Skin has incomplete joint influences.');
  return (index) => {
    const point = vec3.copy(vec3.create(), position.getElement(index, []));
    targets.forEach((target, i) => {
      if (target && weights[i]) vec3.scaleAndAdd(point, point, target.getElement(index, []), weights[i]!);
    });
    if (!joints) return vec3.transformMat4(point, point, world);
    // glTF jointWorld × inverseBind 已在世界坐标；不能再次乘 mesh world，否则会重复变换。
    const result = vec3.create();
    for (const influence of influences) {
      const ids = influence.indices!.getElement(index, []),
        values = influence.weights!.getElement(index, []);
      values.forEach((weight, i) => {
        if (!weight) return;
        const joint = joints[ids[i]!];
        if (!joint) throw new TripoError('UV_TOPOLOGY', 'Skin references an absent joint.');
        vec3.scaleAndAdd(result, result, vec3.transformMat4(vec3.create(), point, joint), weight);
      });
    }
    return result;
  };
}
