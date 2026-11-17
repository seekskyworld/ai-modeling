"""隔离的 Blender 转换/渲染进程，只读取调用方明确提供的自包含模型与 JSON 配置。"""
import bpy
import json
import math
import os
import sys
import zipfile
import xml.etree.ElementTree as ET
from mathutils import Vector, Matrix
sys.path.insert(0, os.path.dirname(__file__))
from model_materials import sweep_materials, update_sweep, preview_materials
from model_transform import transform_export
from model_preview import display_materials, environment, explode, ground_grid
from model_animation import set_pose, bounds, frame_evidence

with open(sys.argv[sys.argv.index('--') + 1], encoding='utf-8') as stream:
    config = json.load(stream)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=config['source'])
# glTF 导入器为骨骼生成隐藏的 Icosphere 控件；它不是素材，不能参与取景/导出。
for obj in list(bpy.context.scene.objects):
    if obj.type == 'MESH' and not obj.visible_get():
        bpy.data.objects.remove(obj, do_unlink=True)
scene = bpy.context.scene
import_fps = scene.render.fps / scene.render.fps_base
directory = config['directory']


def export_3mf(target):
    # 3MF 使用求值后的世界坐标网格；静态打印格式不包含骨骼或 PBR 材质。
    namespace = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'
    root = ET.Element('model', xmlns=namespace, unit='meter')
    resources = ET.SubElement(root, 'resources')
    build = ET.SubElement(root, 'build')
    graph = bpy.context.evaluated_depsgraph_get()
    for index, obj in enumerate([o for o in scene.objects if o.type == 'MESH'], 1):
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        element = ET.SubElement(resources, 'object', id=str(index), type='model')
        body = ET.SubElement(element, 'mesh')
        vertices = ET.SubElement(body, 'vertices')
        triangles = ET.SubElement(body, 'triangles')
        for vertex in mesh.vertices:
            position = obj.matrix_world @ vertex.co
            ET.SubElement(vertices, 'vertex', **dict(zip(('x', 'y', 'z'), map(str, position))))
        for triangle in mesh.loop_triangles:
            ET.SubElement(triangles, 'triangle', **dict(zip(('v1', 'v2', 'v3'), map(str, triangle.vertices))))
        evaluated.to_mesh_clear()
        ET.SubElement(build, 'item', objectid=str(index))
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('3D/3dmodel.model', ET.tostring(root, encoding='utf-8', xml_declaration=True))
        archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        archive.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')


def materialize_textures(folder):
    # GLB 的内嵌图片没有磁盘文件名；OBJ/FBX 导出器不会自动为它们生成可复制文件。
    images = {node.image for material in bpy.data.materials if material.use_nodes
              for node in material.node_tree.nodes if node.type == 'TEX_IMAGE' and node.image}
    encoding = config.get('texture_format') or 'PNG'
    extension = {'BMP': 'bmp', 'DPX': 'dpx', 'HDR': 'hdr', 'JPEG': 'jpg',
                 'OPEN_EXR': 'exr', 'PNG': 'png', 'TARGA': 'tga', 'TIFF': 'tif', 'WEBP': 'webp'}[encoding]
    # 只有调用方在任何解码/筛选之前确认原件images/textures均为空，才允许编码为空操作。
    # 导入器丢掉原有图片或纹理时仍拒绝，不能单凭当前Blender材料树为空放行。
    if (config.get('texture_format') and not images
            and config.get('source_without_images_or_textures') is not True):
        raise ValueError('The model has no image textures to encode')
    for index, image in enumerate(sorted(images, key=lambda item: item.name)):
        # 修改路径前触发像素加载；否则内嵌图在某些导入路径下会被写成空白。
        if not image.has_data:
            _ = image.pixels[0]
        image.filepath_raw = os.path.join(folder, f'texture-{index}.{extension}')
        image.file_format = encoding
        image.save()
        # FBX 优先读取 packed_file；只改路径会把旧 PNG/JPEG 字节嵌进新扩展名。
        with open(image.filepath_raw, 'rb') as stream:
            encoded = stream.read()
        image.pack(data=encoded, data_len=len(encoded))


def export_usdz(target):
    # Blender 直接导出 USDZ 有时只写贴图引用却漏打包；先写独立 USD 再收集实际依赖。
    from pxr import Sdf, UsdUtils
    folder = os.path.join(directory, 'usd')
    os.mkdir(folder)
    stage = os.path.join(folder, 'model.usdc')
    bpy.ops.wm.usd_export(filepath=stage, export_materials=True, export_textures=True,
                          overwrite_textures=True, convert_world_material=False)
    if not UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(stage), target):
        raise ValueError('Cannot package the USD stage and its texture dependencies')


def convert():
    transform_export(config)
    format_name = config['format']
    packaged = config['output_format'] == 'zip' and format_name != 'obj'
    target = os.path.join(directory, ('model.' + format_name) if packaged else ('output.' + config['output_format']))
    if format_name == 'glb':
        if config.get('texture_format'):
            materialize_textures(directory)
        encoding = config.get('texture_format')
        bpy.ops.export_scene.gltf(filepath=target, export_format='GLB',
            export_image_format=encoding if encoding in ('JPEG', 'WEBP') else 'AUTO')
    elif format_name == 'fbx':
        materialize_textures(directory)
        bpy.ops.export_scene.fbx(filepath=target, path_mode='COPY', embed_textures=True, add_leaf_bones=False)
    elif format_name == 'stl':
        bpy.ops.wm.stl_export(filepath=target)
    elif format_name == 'usdz':
        if config.get('texture_format'):
            materialize_textures(directory)
        export_usdz(target)
    elif format_name == '3mf':
        export_3mf(target)
    elif format_name == 'obj':
        folder = os.path.join(directory, 'obj')
        os.mkdir(folder)
        materialize_textures(folder)
        bpy.ops.wm.obj_export(filepath=os.path.join(folder, 'model.obj'), path_mode='COPY',
                              export_colors=bool(config.get('export_vertex_colors')))
        with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
            for base, _, files in os.walk(folder):
                for file in files:
                    location = os.path.join(base, file)
                    archive.write(location, os.path.relpath(location, folder))
    if packaged:
        with zipfile.ZipFile(os.path.join(directory, 'output.zip'), 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.write(target, os.path.basename(target))


def aim(camera, point):
    camera.rotation_euler = (point - camera.location).to_track_quat('-Z', 'Y').to_euler()


def render():
    meshes = [o for o in scene.objects if o.type == 'MESH']
    if not meshes:
        raise ValueError('Model has no visible mesh')
    frames = round(config.get('duration', 1) * config.get('fps', 1)) if config['action'] == 'video' else 1
    # 动作预览按最多 17 个姿态共同取景；固定镜头不会因为每帧包围盒改变而抖动。
    samples = sorted({round(i * (frames - 1) / 16) for i in range(17)})
    limits = []
    for sample in samples:
        set_pose(scene, config, sample / config.get('fps', 1), import_fps)
        saved = explode(meshes, config.get('explode', 0))
        limits.extend(bounds(meshes))
        for obj, matrix in saved:
            obj.matrix_world = matrix
    minimum = Vector([min(p[i] for p in limits) for i in range(3)])
    maximum = Vector([max(p[i] for p in limits) for i in range(3)])
    center = (minimum + maximum) / 2
    radius = max((maximum - minimum).length / 2, 0.01)
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
    scene.render.resolution_x = config['size']
    scene.render.resolution_y = config['size']
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = config['action'] != 'video'
    scene.world.color = (0.08, 0.08, 0.08)
    scene.view_settings.view_transform = 'Standard'
    display_materials(meshes, config.get('display_mode', 'material'))
    preview_materials(meshes, config)
    controls = sweep_materials(meshes, minimum, maximum) if config.get('template') == 'showcase-sweep' else []
    rotation = environment(scene, config)
    if rotation is None:
        for index, (position, strength) in enumerate([((3, -4, 5), 400), ((-4, -1, 2), 180), ((1, 3, 4), 300)]):
            light = bpy.data.lights.new('Studio Light ' + str(index), 'AREA')
            light.energy = strength * radius * radius
            light.shape = 'DISK'
            light.size = radius * 4
            obj = bpy.data.objects.new(light.name, light)
            scene.collection.objects.link(obj)
            obj.location = center + Vector(position) * radius
            aim(obj, center)
    if config.get('grid'):
        ground_grid(scene, center, radius, minimum.z)
    camera_data = bpy.data.cameras.new('Camera')
    camera = bpy.data.objects.new('Camera', camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    perspective = config['action'] == 'brush_snapshot' or config.get('projection') == 'perspective'
    camera_data.type = 'PERSP' if perspective else 'ORTHO'
    if perspective:
        camera_data.sensor_fit = 'VERTICAL'
        camera_data.lens = camera_data.sensor_height / (2 * math.tan(math.radians(config.get('fov', 50)) / 2))
    zoom = config.get('zoom', 1)
    camera_data.ortho_scale = radius * 2.4 / zoom
    camera_data.clip_end = radius * 1000
    reports = []
    for frame in range(frames):
        seconds = frame / config.get('fps', 1)
        selected_time = set_pose(scene, config, seconds, import_fps)
        saved = explode(meshes, config.get('explode', 0))
        turn = frame / frames * math.tau if config.get('camera_motion', 'turntable') == 'turntable' else 0
        angle = math.radians(config.get('azimuth', 30)) + turn
        elevation = math.radians(config.get('elevation', 15))
        distance = radius * 1.1 / math.sin(math.radians(config.get('fov', 50)) / 2) if perspective else radius * 4
        if perspective:
            distance /= zoom
        camera.location = center + distance * Vector((math.sin(angle) * math.cos(elevation), -math.cos(angle) * math.cos(elevation), math.sin(elevation)))
        aim(camera, center)
        # 平移使用相机本地轴，不改变观察方向；倍率相对于同一联合包围盒。
        span = radius * 2.4 / zoom
        camera.location += camera.rotation_euler.to_quaternion() @ Vector((config.get('pan_x', 0) * span, config.get('pan_y', 0) * span, 0))
        if rotation is not None and config.get('environment_auto_rotate'):
            rotation.default_value[2] = -math.radians(config.get('environment_rotation', 0)) - seconds * 0.5
        update_sweep(controls, frame / max(1, frames - 1))
        bpy.context.view_layer.update()
        if config['action'] == 'brush_snapshot':
            matrix = Matrix.Rotation(-math.pi / 2, 4, 'X') @ camera.matrix_world
            with open(os.path.join(directory, 'camera.json'), 'w', encoding='utf-8') as stream:
                json.dump({'camera_matrix': [matrix[row][col] for col in range(4) for row in range(4)], 'fov': config['fov'], 'width': config['size'], 'height': config['size'], 'coordinate_system': 'glTF Y-up; column-major camera world matrix'}, stream)
        else:
            reports.append(frame_evidence(scene, camera, meshes, selected_time, config.get('skeleton')))
        scene.render.filepath = os.path.join(directory, ('frame-%04d.png' % (frame + 1)) if config['action'] == 'video' else 'output.png')
        bpy.ops.render.render(write_still=True)
        for obj, matrix in saved:
            obj.matrix_world = matrix
    if reports:
        with open(os.path.join(directory, 'preview.json'), 'w', encoding='utf-8') as stream:
            json.dump({'frames': reports, 'fit_bounds': [list(minimum), list(maximum)]}, stream)


convert() if config['action'] == 'convert' else render()
