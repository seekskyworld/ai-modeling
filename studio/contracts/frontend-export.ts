/** 网页导出的可证明 metadata；材质覆盖由 is_pbr 分支决定，不把编辑值当成源文件原值。 */
export type FrontendMaterialFactor = { metallic: number; roughness: number };
export type FrontendGeometryMetadata = {
  transform_matrix?: number[];
  children_transform_matrix?: Record<string, number[]>;
  children_deleted?: string[];
  children_rename?: Record<string, string>;
};
export type StudioFrontendMetadata = FrontendGeometryMetadata & {
  forward_axis: '+x' | '-x' | '+y' | '-y';
  pivot_to_center_bottom: boolean;
  material_factor?: FrontendMaterialFactor;
};

function matrix(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 16 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}
function geometryShape(value: Record<string, unknown>): boolean {
  const transforms = value.children_transform_matrix,
    deleted = value.children_deleted;
  return (
    (value.transform_matrix === undefined || matrix(value.transform_matrix)) &&
    (transforms === undefined ||
      (transforms !== null &&
        typeof transforms === 'object' &&
        !Array.isArray(transforms) &&
        Object.entries(transforms).length <= 2048 &&
        Object.entries(transforms).every(
          ([name, transform]) => name.length > 0 && name.length <= 1024 && matrix(transform),
        ))) &&
    (deleted === undefined ||
      (Array.isArray(deleted) &&
        deleted.length <= 2048 &&
        deleted.every((name) => typeof name === 'string' && name.length > 0 && name.length <= 1024))) &&
    (value.children_rename === undefined || isFrontendDisplayRenames(value.children_rename))
  );
}

/** 网页显示别名不改原GLB节点名；仍冻结原键值并仅允许经静态源逐名验证的记录。 */
export function isFrontendDisplayRenames(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).length <= 2048 &&
    Object.entries(value).every(
      ([name, label]) =>
        name.length > 0 &&
        name.length <= 1024 &&
        typeof label === 'string' &&
        label.length > 0 &&
        label.length <= 100,
    )
  );
}

export function isFrontendMaterialFactor(value: unknown): value is FrontendMaterialFactor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    ['metallic', 'roughness'].every(
      (key) =>
        typeof record[key] === 'number' &&
        Number.isFinite(record[key]) &&
        record[key] >= 0 &&
        record[key] <= 1,
    )
  );
}

export function isStudioFrontendMetadata(value: unknown): value is StudioFrontendMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) =>
      [
        'forward_axis',
        'pivot_to_center_bottom',
        'material_factor',
        'transform_matrix',
        'children_transform_matrix',
        'children_deleted',
        'children_rename',
      ].includes(key),
    ) &&
    typeof record.forward_axis === 'string' &&
    ['+x', '-x', '+y', '-y'].includes(record.forward_axis) &&
    typeof record.pivot_to_center_bottom === 'boolean' &&
    (record.material_factor === undefined || isFrontendMaterialFactor(record.material_factor)) &&
    geometryShape(record)
  );
}

/** 忽略已有合同允许的空字段及精确单位root矩阵；保留有名称的编辑供实际GLB节点逐一验证。 */
export function effectiveFrontendGeometryMetadata(
  metadata: Record<string, unknown>,
): FrontendGeometryMetadata {
  const effective: Record<string, unknown> = {};
  const empty = (value: unknown) =>
    value === undefined || value === null || (typeof value === 'object' && Object.keys(value).length === 0);
  for (const key of [
    'transform_matrix',
    'children_transform_matrix',
    'children_deleted',
    'children_rename',
  ]) {
    const value = metadata[key];
    if (empty(value)) continue;
    if (
      key === 'transform_matrix' &&
      Array.isArray(value) &&
      value.length === 16 &&
      value.every((entry, index) => entry === (index % 5 === 0 ? 1 : 0))
    )
      continue;
    effective[key] = value;
  }
  return effective as FrontendGeometryMetadata;
}

/** 当前网页 !operator.is_pbr 时删除 material_factor；缺字段按网页 false 分支，不猜测源纹理角色。 */
export function effectiveFrontendMaterialFactor(
  metadata: Record<string, unknown>,
  isPbr: boolean,
): FrontendMaterialFactor | undefined {
  return isPbr && isFrontendMaterialFactor(metadata.material_factor)
    ? { ...metadata.material_factor }
    : undefined;
}
