"""本地展示视频材质；重现网页暗色转台和线框扫光的功能，渲染器为 Blender。"""
import bpy


def preview_materials(meshes, config):
    """网页临时视口选项的本地对应；只用于截图/展示，不改变正式导出模型。"""
    for obj in meshes:
        shading = config.get('shading', 'original')
        if shading != 'original':
            for polygon in obj.data.polygons:
                polygon.use_smooth = shading == 'smooth'
        if not config.get('wireframe'):
            continue
        if not obj.data.materials:
            obj.data.materials.append(bpy.data.materials.new('Model'))
        for slot in obj.material_slots:
            material = slot.material.copy() if slot.material else bpy.data.materials.new('Model')
            slot.material = material
            material.use_nodes = True
            nodes, links = material.node_tree.nodes, material.node_tree.links
            output = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
            if not output:
                output = nodes.new('ShaderNodeOutputMaterial')
            original = output.inputs['Surface'].links[0].from_socket if output.inputs['Surface'].is_linked else nodes.new('ShaderNodeBsdfPrincipled').outputs[0]
            wire = nodes.new('ShaderNodeWireframe')
            wire.use_pixel_size = True
            wire.inputs['Size'].default_value = 1
            dark = nodes.new('ShaderNodeEmission')
            dark.inputs['Color'].default_value = (0.015, 0.02, 0.025, 1)
            blend = nodes.new('ShaderNodeMixShader')
            links.new(wire.outputs[0], blend.inputs[0])
            links.new(original, blend.inputs[1])
            links.new(dark.outputs[0], blend.inputs[2])
            links.new(blend.outputs[0], output.inputs['Surface'])


def sweep_materials(meshes, minimum, maximum):
    controls = []
    for obj in meshes:
        if not obj.data.materials:
            obj.data.materials.append(bpy.data.materials.new('Model'))
        for slot in obj.material_slots:
            material = slot.material.copy() if slot.material else bpy.data.materials.new('Model')
            slot.material = material
            material.use_nodes = True
            nodes, links = material.node_tree.nodes, material.node_tree.links
            output = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL'), None)
            if not output:
                output = nodes.new('ShaderNodeOutputMaterial')
            original = output.inputs['Surface'].links[0].from_socket if output.inputs['Surface'].is_linked else nodes.new('ShaderNodeBsdfPrincipled').outputs[0]
            geometry = nodes.new('ShaderNodeNewGeometry')
            position = nodes.new('ShaderNodeSeparateXYZ')
            links.new(geometry.outputs['Position'], position.inputs[0])
            threshold = nodes.new('ShaderNodeValue')
            threshold.outputs[0].default_value = maximum.z
            controls.append((threshold.outputs[0], minimum.z, maximum.z))
            reveal = nodes.new('ShaderNodeMath')
            reveal.operation = 'GREATER_THAN'
            links.new(position.outputs['Z'], reveal.inputs[0])
            links.new(threshold.outputs[0], reveal.inputs[1])
            wire = nodes.new('ShaderNodeWireframe')
            wire.use_pixel_size = True
            wire.inputs['Size'].default_value = 1
            color = nodes.new('ShaderNodeMixRGB')
            color.inputs[1].default_value = (0.015, 0.025, 0.035, 1)
            color.inputs[2].default_value = (0.55, 0.7, 0.8, 1)
            links.new(wire.outputs[0], color.inputs[0])
            emission = nodes.new('ShaderNodeEmission')
            links.new(color.outputs[0], emission.inputs[0])
            mix = nodes.new('ShaderNodeMixShader')
            links.new(reveal.outputs[0], mix.inputs[0])
            links.new(emission.outputs[0], mix.inputs[1])
            links.new(original, mix.inputs[2])
            distance = nodes.new('ShaderNodeMath')
            distance.operation = 'SUBTRACT'
            links.new(position.outputs['Z'], distance.inputs[0])
            links.new(threshold.outputs[0], distance.inputs[1])
            absolute = nodes.new('ShaderNodeMath')
            absolute.operation = 'ABSOLUTE'
            links.new(distance.outputs[0], absolute.inputs[0])
            band = nodes.new('ShaderNodeMath')
            band.operation = 'LESS_THAN'
            band.inputs[1].default_value = max((maximum.z - minimum.z) * 0.025, 0.002)
            links.new(absolute.outputs[0], band.inputs[0])
            glow = nodes.new('ShaderNodeEmission')
            glow.inputs[0].default_value = (0.3, 0.85, 1, 1)
            glow.inputs[1].default_value = 2.5
            final = nodes.new('ShaderNodeMixShader')
            links.new(band.outputs[0], final.inputs[0])
            links.new(mix.outputs[0], final.inputs[1])
            links.new(glow.outputs[0], final.inputs[2])
            links.new(final.outputs[0], output.inputs['Surface'])
    return controls


def update_sweep(controls, progress):
    # 前半段线框扫光变为材质，后半段保留完整模型展示。
    for socket, low, high in controls:
        socket.default_value = high - (high - low) * (min(1.15, progress * 2.3) - 0.05)
