/** 复现网页 GLTFLoader 的浅节点登记与 Mi 场景过滤；统计值并不等于文件的全部几何面数。 */
import { array, object } from './contracts/errors.ts';

type Json = Record<string, unknown>;
export class GltfFaceScopeError extends Error {}
export interface PrimitiveFaces {
  mesh: boolean;
  faces: number;
}
const clean = (name: string) => name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');

export function countWebGltfFaces(json: Json, primitives: PrimitiveFaces[][]): number {
  const nodes = array(json.nodes).map(object);
  const scenes = array(json.scenes).map(object);
  const meshes = array(json.meshes).map(object);
  const skins = array(json.skins).map(object);
  const cameras = array(json.cameras).map(object);
  const lights = array(object(object(json.extensions).KHR_lights_punctual).lights).map(object);
  if (!scenes.length || nodes.length > 100_000 || meshes.length !== primitives.length)
    throw new GltfFaceScopeError('glTF has no verifiable bounded scene layout.');
  const index = (value: unknown, length: number): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= length)
      throw new GltfFaceScopeError('glTF contains an unresolved scene dependency.');
    return value;
  };
  const joints = new Set([
    ...skins.flatMap((skin) => array(skin.joints).map((id) => index(id, nodes.length))),
    ...nodes.flatMap((node, id) => (node.isBone === true ? [id] : [])),
  ]);
  const used: Record<string, number> = {};
  function unique(value: unknown): string {
    if (typeof value !== 'string') throw new GltfFaceScopeError('glTF names must be strings.');
    const name = clean(value);
    // 与网页普通对象的 typeof 检查保持一致，包括 __proto__ 赋数值被忽略的行为。
    if (typeof used[name] === 'number') return `${name}_${++used[name]}`;
    used[name] = 0;
    return name;
  }
  const names = new Map<number, string>();
  const loaded = new Set<number>();
  const loading = new Set<number>();
  const meshRefs = new Map<number, number>();
  const cameraRefs = new Map<number, number>();
  const lightRefs = new Map<number, number>();
  const cameraNames = new Map<number, string>();
  const lightNames = new Map<number, string>();
  const meshUses = new Map<number, number>(),
    cameraUses = new Map<number, number>(),
    lightUses = new Map<number, number>();
  const meshInstances = new Map<number, number>(),
    cameraInstances = new Map<number, number>(),
    lightInstances = new Map<number, number>();
  function instance(uses: Map<number, number>, id: number): number {
    const index = uses.get(id) ?? 0;
    uses.set(id, index + 1);
    return index;
  }
  const touchedMeshes = new Set<number>();
  const add = (map: Map<number, number>, id: number) => map.set(id, (map.get(id) ?? 0) + 1);
  const lightOf = (node: Json) => object(object(node.extensions).KHR_lights_punctual).light;
  function registerReferences(): void {
    for (const node of nodes) {
      if (node.mesh !== undefined) add(meshRefs, index(node.mesh, meshes.length));
      if (node.camera !== undefined) add(cameraRefs, index(node.camera, cameras.length));
      if (lightOf(node) !== undefined) add(lightRefs, index(lightOf(node), lights.length));
    }
  }
  registerReferences();
  function camera(id: number): void {
    if (cameraNames.has(id)) return;
    const definition = cameras[id]!;
    if (!['perspective', 'orthographic'].includes(String(definition.type)))
      throw new GltfFaceScopeError('glTF camera type is invalid.');
    cameraNames.set(id, definition.name ? unique(definition.name) : '');
  }
  function shallow(id: number): void {
    if (names.has(id)) return;
    const node = nodes[id]!;
    names.set(id, node.name ? unique(node.name) : '');
    if (node.mesh !== undefined) {
      const mesh = index(node.mesh, meshes.length);
      touchedMeshes.add(mesh);
      meshInstances.set(id, instance(meshUses, mesh));
    }
    if (node.camera !== undefined) {
      const cameraId = index(node.camera, cameras.length);
      camera(cameraId);
      cameraInstances.set(id, instance(cameraUses, cameraId));
    }
    if (lightOf(node) !== undefined) {
      const light = index(lightOf(node), lights.length),
        definition = lights[light]!;
      if (!['directional', 'point', 'spot'].includes(String(definition.type)))
        throw new GltfFaceScopeError('glTF light type is invalid.');
      if (!lightNames.has(light)) lightNames.set(light, unique(definition.name || `light_${light}`));
      lightInstances.set(id, instance(lightUses, light));
    }
  }
  function load(id: number, depth = 0): void {
    if (loading.has(id) || depth > 64) throw new GltfFaceScopeError('glTF scene is cyclic or too deep.');
    if (loaded.has(id)) return;
    loading.add(id);
    shallow(id);
    const node = nodes[id]!;
    for (const child of array(node.children)) load(index(child, nodes.length), depth + 1);
    if (node.skin !== undefined)
      for (const joint of array(skins[index(node.skin, skins.length)]!.joints))
        shallow(index(joint, nodes.length));
    loading.delete(id);
    loaded.add(id);
  }
  const sceneNames: string[] = [];
  function loadRoots(): void {
    for (const scene of scenes) {
      sceneNames.push(scene.name ? unique(scene.name) : '');
      for (const node of array(scene.nodes)) load(index(node, nodes.length));
    }
    for (const animation of array(json.animations))
      for (const channel of array(object(animation).channels)) {
        const target = object(object(channel).target).node;
        if (target !== undefined) load(index(target, nodes.length));
      }
    for (let id = 0; id < cameras.length; id++) camera(id);
  }
  loadRoots();

  const eligible = (id: number) => {
    const node = nodes[id]!;
    return (
      !!node.name &&
      node.mesh !== undefined &&
      !joints.has(id) &&
      node.camera === undefined &&
      lightOf(node) === undefined &&
      primitives[Number(node.mesh)]?.length === 1 &&
      primitives[Number(node.mesh)]![0]!.mesh
    );
  };
  const info = new Map<string, number>();
  let raw = 0;
  function collectMetadata(): void {
    for (const [id, name] of names) {
      if (!eligible(id)) continue;
      const faces = primitives[Number(nodes[id]!.mesh)]![0]!.faces;
      raw += faces;
      if (name === '__proto__') continue;
      if (info.has(name) && info.get(name) !== faces)
        throw new GltfFaceScopeError(
          'glTF generated-name collision depends on asynchronous geometry/material completion order.',
        );
      info.set(name, faces);
    }
  }
  collectMetadata();
  // 全部为未命名/Group 的文件确实得到网页统计 0；只有 __proto__ 时保留原始累加。
  const selected = index(json.scene ?? 0, scenes.length);
  if (!info.size) return raw;
  const visible = new Set<string>([sceneNames[selected]!]);
  const owners = new Map<number, string>();
  const selectedNodes = new Set<number>();
  const sceneRoots = scenes.map((scene) => JSON.stringify(array(scene.nodes)));
  function visit(id: number, owner: string, depth = 0): void {
    if (depth > 64) throw new GltfFaceScopeError('glTF hierarchy is too deep.');
    const previous = owners.get(id);
    if (previous !== undefined && previous !== owner) {
      const previousScene = /^scene:(\d+)$/.exec(previous),
        currentScene = /^scene:(\d+)$/.exec(owner);
      if (
        previousScene &&
        currentScene &&
        sceneRoots[Number(previousScene[1])] === sceneRoots[Number(currentScene[1])]
      ) {
        // 相同根依赖的 Promise.all 按场景顺序完成，最后一个场景保留共享对象。
        owners.set(id, owner);
        return;
      }
      throw new GltfFaceScopeError(
        'glTF shared scene nodes depend on asynchronous reparenting in the webpage loader.',
      );
    }
    if (previous !== undefined) return;
    owners.set(id, owner);
    for (const child of array(nodes[id]!.children))
      visit(index(child, nodes.length), `node:${id}`, depth + 1);
  }
  scenes.forEach((scene, sceneId) => {
    for (const node of array(scene.nodes)) visit(index(node, nodes.length), `scene:${sceneId}`);
  });
  function selectNode(id: number): void {
    if (selectedNodes.has(id)) return;
    selectedNodes.add(id);
    for (const child of array(nodes[id]!.children)) selectNode(index(child, nodes.length));
  }
  for (const root of array(scenes[selected]!.nodes)) {
    const id = index(root, nodes.length);
    if (owners.get(id) === `scene:${selected}`) selectNode(id);
  }

  // mesh 名称在异步 loadMesh 完成时才分配。通常不会与节点登记键相交；只在确实影响过滤时保留未核实。
  const ranges = new Map<string, { first: number; last: number }>();
  function meshNameRanges(): void {
    for (const id of touchedMeshes) {
      const name = clean(String(meshes[id]!.name || `mesh_${id}`));
      const range = ranges.get(name) ?? {
        first: typeof used[name] === 'number' ? used[name]! + 1 : 0,
        last: 0,
      };
      range.last = (ranges.has(name) ? range.last : range.first - 1) + primitives[id]!.length;
      ranges.set(name, range);
    }
  }
  meshNameRanges();
  const ordinary = new Set<string>();
  const instances = new Map<string, Set<number>>();
  function attachment(name: string, refs: number, instance: number): void {
    visible.add(refs <= 1 ? name : `${name}_instance_${instance}`);
  }
  function recordMeshNode(id: number, mesh?: number): void {
    const node = nodes[id]!;
    if (mesh !== undefined && (!eligible(id) || !node.name)) {
      const base = clean(String(meshes[mesh]!.name || `mesh_${mesh}`));
      if (primitives[mesh]!.length !== 1) ordinary.add(base);
      else if ((meshRefs.get(mesh) ?? 0) > 1) {
        if (!instances.has(base)) instances.set(base, new Set());
        instances.get(base)!.add(meshInstances.get(id)!);
      } else ordinary.add(base);
    }
  }
  function recordAttachments(node: Json, grouped: boolean, id: number): void {
    if (node.camera !== undefined && (grouped || !node.name))
      attachment(
        cameraNames.get(Number(node.camera))!,
        cameraRefs.get(Number(node.camera))!,
        cameraInstances.get(id)!,
      );
    if (lightOf(node) !== undefined) {
      const light = Number(lightOf(node));
      if (grouped || !node.name)
        attachment(lightNames.get(light)!, lightRefs.get(light)!, lightInstances.get(id)!);
      if (lights[light]!.type !== 'point') visible.add('');
    }
  }
  function recordVisibleNode(id: number): void {
    const node = nodes[id]!,
      mesh = node.mesh === undefined ? undefined : Number(node.mesh);
    const attached =
      Number(mesh !== undefined) + Number(node.camera !== undefined) + Number(lightOf(node) !== undefined);
    const composed = joints.has(id) || attached !== 1;
    const multiple = mesh !== undefined && primitives[mesh]!.length !== 1;
    const grouped = composed || multiple;
    if (node.name || composed || (multiple && (meshRefs.get(mesh!) ?? 0) <= 1)) visible.add(names.get(id)!);
    else if (multiple) attachment('', meshRefs.get(mesh!)!, meshInstances.get(id)!);
    if (composed && multiple) attachment('', meshRefs.get(mesh!)!, meshInstances.get(id)!);
    recordMeshNode(id, mesh);
    recordAttachments(node, grouped, id);
  }
  for (const id of selectedNodes) recordVisibleNode(id);
  function generated(
    key: string,
    allowed: Set<string> | Map<string, Set<number>>,
    instance?: number,
  ): boolean {
    const candidates: [string, number][] = [[key, 0]];
    const numbered = /^(.*)_(\d+)$/.exec(key);
    if (numbered) candidates.push([numbered[1]!, Number(numbered[2])]);
    return candidates.some(([base, number]) => {
      const range = ranges.get(base);
      return (
        allowed.has(base) &&
        !!range &&
        number >= range.first &&
        number <= range.last &&
        (instance === undefined || !!instances.get(base)?.has(instance))
      );
    });
  }
  function filteredCount(): number {
    let count = 0;
    for (const [key, faces] of info) {
      if (visible.has(key)) {
        count += faces;
        continue;
      }
      const instance = /^(.*)_instance_(\d+)$/.exec(key);
      if (generated(key, ordinary) || (instance && generated(instance[1]!, instances, Number(instance[2]))))
        throw new GltfFaceScopeError(
          'glTF asynchronous unnamed mesh names overlap metadata from another scene.',
        );
    }
    return count;
  }
  return filteredCount();
}
