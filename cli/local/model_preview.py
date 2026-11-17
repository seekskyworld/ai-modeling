"""网页视口模式的 Blender 对应；独立材质与世界光照只用于预览，不回写原 GLB。"""
import bpy
import math
from mathutils import Vector


def emission(nodes, links, color):
    node = nodes.new('ShaderNodeEmission')
    if hasattr(color, 'node'):
        links.new(color, node.inputs['Color'])
    else:
        node.inputs['Color'].default_value = color
    return node.outputs[0]


def normal_color(nodes, links):
    geometry = nodes.new('ShaderNodeNewGeometry')
    transform = nodes.new('ShaderNodeVectorTransform')
    transform.vector_type, transform.convert_from, transform.convert_to = 'NORMAL', 'WORLD', 'CAMERA'
    links.new(geometry.outputs['Normal'], transform.inputs[0])
    scale = nodes.new('ShaderNodeVectorMath')
    scale.operation = 'MULTIPLY_ADD'
    # Blender shader 的相机 Z 指向视线内部；网页 normal view 用朝观察者的正 Z。
    scale.inputs[1].default_value = (0.5, 0.5, -0.5)
    scale.inputs[2].default_value = (0.5, 0.5, 0.5)
    links.new(transform.outputs[0], scale.inputs[0])
    return scale.outputs[0]


def base_color(nodes):
    principled = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not principled:
        return (0.8, 0.8, 0.8, 1)
    color = principled.inputs['Base Color']
    return color.links[0].from_socket if color.is_linked else tuple(color.default_value)


def toon(nodes, links, color):
    diffuse = nodes.new('ShaderNodeBsdfDiffuse')
    rgb = nodes.new('ShaderNodeShaderToRGB')
    links.new(diffuse.outputs[0], rgb.inputs[0])
    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    ramp.color_ramp.elements[0].position = 0.12
    ramp.color_ramp.elements[0].color = (0.16, 0.16, 0.16, 1)
    ramp.color_ramp.elements[1].position = 0.7
    middle = ramp.color_ramp.elements.new(0.38)
    middle.color = (0.55, 0.55, 0.55, 1)
    links.new(rgb.outputs[0], ramp.inputs[0])
    multiply = nodes.new('ShaderNodeMixRGB')
    multiply.blend_type = 'MULTIPLY'
    multiply.inputs[0].default_value = 1
    links.new(ramp.outputs[0], multiply.inputs[1])
    if hasattr(color, 'node'):
        links.new(color, multiply.inputs[2])
    else:
        multiply.inputs[2].default_value = color
    return emission(nodes, links, multiply.outputs[0])


def rim_style(nodes, links, mode):
    layer = nodes.new('ShaderNodeLayerWeight')
    layer.inputs['Blend'].default_value = 0.35
    ramp = nodes.new('ShaderNodeValToRGB')
    links.new(layer.outputs['Facing'], ramp.inputs[0])
    if mode == 'solid':
        ramp.color_ramp.elements[0].color = (0.75, 0.78, 0.82, 1)
        ramp.color_ramp.elements[1].color = (0.12, 0.13, 0.15, 1)
    else:
        ramp.color_ramp.elements[0].color = (0.005, 0.08, 0.1, 1)
        ramp.color_ramp.elements[1].color = (0.02, 0.9, 1, 1)
    color = ramp.outputs[0]
    if mode == 'hologram':
        wave = nodes.new('ShaderNodeTexWave')
        wave.bands_direction = 'Z'
        wave.inputs['Scale'].default_value = 45
        mix = nodes.new('ShaderNodeMixRGB')
        mix.blend_type = 'MULTIPLY'
        mix.inputs[0].default_value = 0.6
        links.new(color, mix.inputs[1])
        links.new(wave.outputs['Color'], mix.inputs[2])
        color = mix.outputs[0]
    shader = emission(nodes, links, color)
    if mode == 'hologram':
        transparent = nodes.new('ShaderNodeBsdfTransparent')
        blend = nodes.new('ShaderNodeMixShader')
        blend.inputs[0].default_value = 0.65
        links.new(transparent.outputs[0], blend.inputs[1])
        links.new(shader, blend.inputs[2])
        shader = blend.outputs[0]
    return shader


def sketch(nodes, links):
    """用光照阈值、斜线与轮廓实现素描预览；不复制网页屏幕空间着色器。"""
    diffuse = nodes.new('ShaderNodeBsdfDiffuse')
    rgb = nodes.new('ShaderNodeShaderToRGB')
    links.new(diffuse.outputs[0], rgb.inputs[0])
    light = nodes.new('ShaderNodeValToRGB')
    light.color_ramp.elements[0].position = 0.15
    light.color_ramp.elements[1].position = 0.65
    links.new(rgb.outputs[0], light.inputs[0])
    coords = nodes.new('ShaderNodeTexCoord')
    wave = nodes.new('ShaderNodeTexWave')
    wave.bands_direction = 'DIAGONAL'
    wave.inputs['Scale'].default_value = 80
    links.new(coords.outputs['Window'], wave.inputs['Vector'])
    hatch = nodes.new('ShaderNodeValToRGB')
    hatch.color_ramp.interpolation = 'CONSTANT'
    hatch.color_ramp.elements[0].color = (0.025, 0.025, 0.025, 1)
    hatch.color_ramp.elements[1].position = 0.55
    hatch.color_ramp.elements[1].color = (0.8, 0.8, 0.77, 1)
    links.new(wave.outputs['Fac'], hatch.inputs[0])
    mix = nodes.new('ShaderNodeMixRGB')
    links.new(light.outputs[0], mix.inputs[0])
    links.new(hatch.outputs[0], mix.inputs[1])
    mix.inputs[2].default_value = (0.93, 0.93, 0.9, 1)
    layer = nodes.new('ShaderNodeLayerWeight')
    edge = nodes.new('ShaderNodeValToRGB')
    edge.color_ramp.elements[0].position = 0.6
    edge.color_ramp.elements[0].color = (1, 1, 1, 1)
    edge.color_ramp.elements[1].position = 0.85
    edge.color_ramp.elements[1].color = (0.02, 0.02, 0.02, 1)
    links.new(layer.outputs['Facing'], edge.inputs[0])
    multiply = nodes.new('ShaderNodeMixRGB')
    multiply.blend_type = 'MULTIPLY'
    multiply.inputs[0].default_value = 1
    links.new(mix.outputs[0], multiply.inputs[1])
    links.new(edge.outputs[0], multiply.inputs[2])
    return emission(nodes, links, multiply.outputs[0])


def display_materials(meshes, mode):
    if mode == 'material':
        return
    for obj in meshes:
        if not obj.data.materials:
            obj.data.materials.append(bpy.data.materials.new('Preview'))
        for slot in obj.material_slots:
            material = slot.material.copy() if slot.material else bpy.data.materials.new('Preview')
            slot.material = material
            material.use_nodes = True
            nodes, links = material.node_tree.nodes, material.node_tree.links
            output = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
            if not output:
                output = nodes.new('ShaderNodeOutputMaterial')
            if mode == 'normal':
                shader = emission(nodes, links, normal_color(nodes, links))
            elif mode == 'unlit':
                shader = emission(nodes, links, base_color(nodes))
            elif mode == 'toon':
                shader = toon(nodes, links, base_color(nodes))
            elif mode == 'sketch':
                shader = sketch(nodes, links)
            else:
                shader = rim_style(nodes, links, mode)
            links.new(shader, output.inputs['Surface'])


def environment(scene, config):
    """网页 Y 轴对应 Blender Z 轴；自动旋转速度来源为 Cil2uMhd 的 delta * 0.5。"""
    if not config.get('hdr_path'):
        return None
    scene.world.use_nodes = True
    nodes, links = scene.world.node_tree.nodes, scene.world.node_tree.links
    nodes.clear()
    coords = nodes.new('ShaderNodeTexCoord')
    mapping = nodes.new('ShaderNodeMapping')
    links.new(coords.outputs['Normal'], mapping.inputs['Vector'])
    texture = nodes.new('ShaderNodeTexEnvironment')
    texture.image = bpy.data.images.load(config['hdr_path'])
    links.new(mapping.outputs[0], texture.inputs[0])
    background = nodes.new('ShaderNodeBackground')
    background.inputs['Strength'].default_value = config.get('environment_intensity', 1)
    links.new(texture.outputs[0], background.inputs['Color'])
    output = nodes.new('ShaderNodeOutputWorld')
    links.new(background.outputs[0], output.inputs[0])
    # 世界贴图坐标使用反向旋转，才能与网页场景环境的正向旋转一致。
    mapping.inputs['Rotation'].default_value[2] = -math.radians(config.get('environment_rotation', 0))
    return mapping.inputs['Rotation']


def explode(meshes, factor):
    """采用网页最终展开的径向距离权重；随机旋转属于展示动画，不写入确定性截图。"""
    if not factor or len(meshes) < 2:
        return []
    boxes = [[obj.matrix_world @ Vector(corner) for corner in obj.bound_box] for obj in meshes]
    points = [point for box in boxes for point in box]
    low = Vector([min(p[i] for p in points) for i in range(3)])
    high = Vector([max(p[i] for p in points) for i in range(3)])
    center = (low + high) / 2
    centers = [sum(box, Vector()) / 8 for box in boxes]
    threshold = (high - low).length * 0.03
    distances = [(c - center).length for c in centers]
    substantial = [d for d, box in zip(distances, boxes) if (box[6] - box[0]).length >= threshold]
    maximum = max(substantial or distances)
    saved = []
    for obj, part_center, distance in zip(meshes, centers, distances):
        saved.append((obj, obj.matrix_world.copy()))
        direction = part_center - center
        if direction.length < 0.0001:
            direction = Vector((1, 0, 0))
        offset = direction.normalized() * maximum * (0.35 + 0.65 * min(1, distance / max(maximum, 1e-6))) * factor
        matrix = obj.matrix_world.copy()
        matrix.translation += offset
        obj.matrix_world = matrix
    bpy.context.view_layer.update()
    return saved


def ground_grid(scene, center, radius, bottom):
    curve = bpy.data.curves.new('Preview ground grid', 'CURVE')
    curve.dimensions = '3D'
    curve.bevel_depth = radius * 0.001
    step = radius / 5
    for axis in (0, 1):
        for index in range(-10, 11):
            spline = curve.splines.new('POLY')
            spline.points.add(1)
            for end, value in enumerate((-radius * 2, radius * 2)):
                point = [center.x, center.y, bottom - radius * 0.005, 1]
                point[axis] += value
                point[1 - axis] += index * step
                spline.points[end].co = point
    material = bpy.data.materials.new('Grid gray')
    material.diffuse_color = (0.15, 0.18, 0.22, 1)
    curve.materials.append(material)
    scene.collection.objects.link(bpy.data.objects.new(curve.name, curve))
