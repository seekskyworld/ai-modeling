"""用隔离的 Blender 进程重新导入最终 GLB，验证几何、贴图、蒙皮和动作。"""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
source, target = Path(args[0]).resolve(), Path(args[1]).resolve()
target.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(source))
scene = bpy.context.scene
rigs = [obj for obj in scene.objects if obj.type == 'ARMATURE']
# glTF 导入器会为骨骼创建 custom_shape 辅助网格；它不属于交付几何，也不参与蒙皮。
custom_shapes = {bone.custom_shape for rig in rigs for bone in rig.pose.bones if bone.custom_shape}
meshes = [obj for obj in scene.objects if obj.type == 'MESH' and obj not in custom_shapes]
if not meshes:
    raise RuntimeError('GLB contains no imported mesh')
points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
minimum = Vector([min(point[i] for point in points) for i in range(3)])
maximum = Vector([max(point[i] for point in points) for i in range(3)])
center = (minimum + maximum) * 0.5
size = max(maximum - minimum)
if not math.isfinite(size) or size <= 0:
    raise RuntimeError('Invalid model bounds')
images = [image for image in bpy.data.images if image.type == 'IMAGE']
report = {
    'file': str(source),
    'meshes': len(meshes),
    'excluded_bone_shapes': len(custom_shapes),
    'vertices': sum(len(obj.data.vertices) for obj in meshes),
    'triangles': sum(sum(len(face.vertices) - 2 for face in obj.data.polygons) for obj in meshes),
    'armatures': len(rigs),
    'bones': sum(len(obj.data.bones) for obj in rigs),
    'unweighted_vertices': sum(sum(1 for v in obj.data.vertices if not any(g.weight > 0 for g in v.groups)) for obj in meshes),
    'textures': [{'name': image.name, 'size': list(image.size), 'packed': bool(image.packed_file)} for image in images],
    'actions': [{'name': action.name, 'frame_range': list(action.frame_range)} for action in bpy.data.actions],
    'bounds': {'min': list(minimum), 'max': list(maximum)},
}
if not rigs or not bpy.data.actions:
    raise RuntimeError('Expected an animated, skinned model')
if report['unweighted_vertices'] or not images or not all(image.packed_file for image in images):
    raise RuntimeError('Expected fully weighted geometry and embedded textures')
scene.render.engine = 'CYCLES'
scene.cycles.samples = 20
scene.render.resolution_x = 768
scene.render.resolution_y = 768
scene.render.resolution_percentage = 100
scene.world = bpy.data.worlds.new('VerificationWorld')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (0.7, 0.75, 0.85, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = 0.6
camera_data = bpy.data.cameras.new('VerificationCamera')
camera = bpy.data.objects.new('VerificationCamera', camera_data)
scene.collection.objects.link(camera)
camera.location = center + Vector((size * 1.6, -size * 2.8, size * 0.8))
camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera_data.type = 'ORTHO'
camera_data.ortho_scale = size * 1.3
scene.camera = camera
for location, power in [((2, -3, 4), 700), ((-3, 1, 2), 450)]:
    light_data = bpy.data.lights.new('VerificationLight', type='AREA')
    light_data.energy = power * size * size
    light_data.shape = 'DISK'
    light_data.size = size * 2
    light = bpy.data.objects.new('VerificationLight', light_data)
    scene.collection.objects.link(light)
    light.location = center + Vector(location) * size
    light.rotation_euler = (center - light.location).to_track_quat('-Z', 'Y').to_euler()
# 比较不同帧的真实骨骼矩阵，避免只有动作名称却没有运动。
poses = []
for frame in [1, 9]:
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    poses.append([round(value, 6) for rig in rigs for bone in rig.pose.bones for row in bone.matrix for value in row])
    scene.render.filepath = str(target / f'robot-frame-{frame}.png')
    bpy.ops.render.render(write_still=True)
report['pose_changes'] = sum(a != b for a, b in zip(*poses))
if report['pose_changes'] == 0:
    raise RuntimeError('Imported animation did not change the skeleton')
(target / 'blender-inspection.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
