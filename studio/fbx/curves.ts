/** 网页将 NURBS 解析成 Line，不加入 Mesh 面数；先证明其结构可解析，不能直接忽略未知曲线。 */
import { singleNode, type FbxNode } from './structure.ts';
import type { FbxConnection } from './deformers.ts';

function value(node: FbxNode, name: string): unknown {
  return singleNode(node.children, name)?.properties[0];
}
function numeric(node: FbxNode, name: string): Float64Array {
  const values = value(node, name);
  if (!(values instanceof Float64Array) || values.some((entry) => !Number.isFinite(entry)))
    throw new Error('FBX NURBS requires complete finite point and knot arrays.');
  return values;
}

function validateKnots(knots: Float64Array, effective: number, order: number, form: unknown): void {
  if (
    knots.length !== effective + order ||
    !(knots[0]! < knots.at(-1)!) ||
    !Number.isFinite(knots.at(-1)! - knots[0]!) ||
    knots.some((entry, index) => index > 0 && entry < knots[index - 1]!)
  )
    throw new Error('FBX NURBS knots must match the effective control count and an ordered finite domain.');
  if (form === 'Periodic') {
    if (knots.some((entry, index) => index > 0 && entry === knots[index - 1]!))
      throw new Error('FBX periodic NURBS currently requires strictly increasing knots.');
  } else {
    const first = knots[0]!,
      last = knots.at(-1)!;
    if (
      knots.subarray(0, order).some((entry) => entry !== first) ||
      knots.subarray(-order).some((entry) => entry !== last)
    )
      throw new Error('FBX open or closed NURBS requires verified clamped endpoint knots.');
    let repeats = 0,
      previous: number | undefined;
    for (const knot of knots.subarray(order, -order)) {
      repeats = knot === previous ? repeats + 1 : 1;
      previous = knot;
      if (knot <= first || knot >= last || repeats >= order)
        throw new Error('FBX NURBS internal knot multiplicity or domain is not verified.');
    }
  }
}

function curve(node: FbxNode): number {
  const rawOrder = value(node, 'Order'),
    order = typeof rawOrder === 'number' ? rawOrder : /^\d+$/.test(String(rawOrder)) ? Number(rawOrder) : NaN,
    form = value(node, 'Form'),
    points = numeric(node, 'Points'),
    knots = numeric(node, 'KnotVector'),
    controls = points.length / 4;
  if (!Number.isSafeInteger(order) || order < 2 || order > 16)
    throw new Error('FBX NURBS order must be a verified integer from 2 to 16.');
  if (!Number.isInteger(controls) || controls < order)
    throw new Error('FBX NURBS control points must have four components and cover the curve order.');
  if (controls > 100000) throw new Error('FBX NURBS exceeds the bounded curve inspection limit.');
  for (let index = 3; index < points.length; index += 4)
    if (points[index]! <= 0)
      throw new Error(
        'FBX NURBS requires positive rational weights; zero or negative weights are unverified.',
      );
  if (!['Open', 'Closed', 'Periodic'].includes(String(form)))
    throw new Error('FBX NURBS curve form is not verified.');
  // 原 loader 对 Closed 补首点，对 Periodic 补 degree 个首点，然后按补点后的维度构建曲线。
  const effective = controls + (form === 'Closed' ? 1 : form === 'Periodic' ? order - 1 : 0);
  validateKnots(knots, effective, order, form);
  return effective;
}

export function validateFbxCurves(
  geometry: Map<number, FbxNode>,
  models: { id: number; type: string }[],
  links: FbxConnection[],
): void {
  let controls = 0;
  const curves = new Set<number>();
  for (const [id, node] of geometry) {
    if (node.properties[2] !== 'NurbsCurve') continue;
    controls += curve(node);
    // 网页每个有效控制点采样12次；超出有界对照范围仍返回未核实，不猜测网页解析成功。
    if (controls > 100000)
      throw new Error('FBX NURBS exceeds the bounded cumulative curve inspection limit.');
    curves.add(id);
  }
  const children = new Map<number, number[]>();
  for (const link of links) {
    if (!children.has(link.parent)) children.set(link.parent, []);
    children.get(link.parent)!.push(link.child);
  }
  for (const model of models) {
    if (model.type !== 'NurbsCurve') continue;
    const sources = children.get(model.id) ?? [];
    // createCurve 的 reduce 在首个 child 尚无几何时立即失败；不能只找后面的一个合法连接。
    if (!curves.has(sources[0]!) || sources.some((id) => geometry.has(id) && !curves.has(id)))
      throw new Error('FBX NURBS model has no verified curve geometry in webpage connection order.');
  }
}
