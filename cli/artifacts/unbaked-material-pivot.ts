/** 只由提交前来源计算原生导出底部中心；绝不从输出反推一个“恰好匹配”的变换。 */
import type { Document } from '@gltf-transform/core';
import { TripoError } from '../../studio/contracts/errors.ts';

export type MaterialPivot = [number, number, number];
export function unbakedMaterialPivot(document: Document): MaterialPivot {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  let vertices = 0;
  for (const node of document.getRoot().listNodes()) {
    const matrix = node.getWorldMatrix();
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const position = primitive.getAttribute('POSITION');
      if (!position || (vertices += position.getCount()) > 1000000)
        throw new TripoError(
          'UNBAKED_MATERIAL_UNSUPPORTED',
          'The explicit native pivot requires bounded source positions.',
          'read',
        );
      for (let i = 0; i < position.getCount(); i++) {
        const point = position.getElement(i, []);
        for (let axis = 0; axis < 3; axis++) {
          const value =
            matrix[axis]! * point[0]! +
            matrix[4 + axis]! * point[1]! +
            matrix[8 + axis]! * point[2]! +
            matrix[12 + axis]!;
          if (!Number.isFinite(value))
            throw new TripoError('UNBAKED_MATERIAL_UNSUPPORTED', 'Source bounds must be finite.', 'read');
          min[axis] = Math.min(min[axis]!, value);
          max[axis] = Math.max(max[axis]!, value);
        }
      }
    }
  }
  if (!vertices)
    throw new TripoError('UNBAKED_MATERIAL_UNSUPPORTED', 'The source has no bounded mesh.', 'read');
  return [min[0]! / 2 + max[0]! / 2, min[1]!, min[2]! / 2 + max[2]! / 2];
}
