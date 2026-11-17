/** 标准有理 B 样条结构；曲线本身不计网页 Mesh 原多边形数。 */
import { staticFbxNodes, type FbxFixtureNode } from './fbx.ts';

export function nurbsFbxNodes(
  options: { form?: 'Open' | 'Closed' | 'Periodic'; order?: number; mesh?: boolean } = {},
): FbxFixtureNode[] {
  const form = options.form ?? 'Open',
    order = options.order ?? 3,
    count = Math.max(order, 4),
    effective = count + (form === 'Closed' ? 1 : form === 'Periodic' ? order - 1 : 0),
    middle = effective - order,
    knots =
      form === 'Periodic'
        ? Array.from({ length: effective + order }, (_, index) => index)
        : [
            ...Array<number>(order).fill(0),
            ...Array.from({ length: middle }, (_, index) => index + 1),
            ...Array<number>(order).fill(middle + 1),
          ],
    nodes = staticFbxNodes(),
    objects = nodes[1]!,
    connections = nodes[2]!;
  if (!options.mesh) {
    objects.children = [];
    connections.children = [];
  }
  objects.children!.push(
    {
      name: 'Geometry',
      properties: [300, 'curve-geometry', 'NurbsCurve'],
      children: [
        { name: 'Order', properties: [order] },
        { name: 'Form', properties: [form] },
        { name: 'KnotVector', properties: [new Float64Array(knots)] },
        {
          name: 'Points',
          properties: [
            new Float64Array(
              Array.from({ length: count }, (_, index) => [
                index,
                Math.sin(index),
                index / 3,
                1 + index / 10,
              ]).flat(),
            ),
          ],
        },
      ],
    },
    { name: 'Model', properties: [400, 'curve', 'NurbsCurve'], children: [] },
  );
  connections.children!.push(
    { name: 'C', properties: ['OO', 300, 400] },
    { name: 'C', properties: ['OO', 400, 0] },
  );
  return nodes;
}
