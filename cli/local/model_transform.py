"""官方导出尺寸/底部选项的本地适配；先缩放，再切平并封口，最后移动轴心。"""
import bpy
import bmesh
from mathutils import Vector, Matrix


def bounds(meshes):
    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    if not points:
        raise ValueError('Export has no mesh')
    return (Vector([min(p[i] for p in points) for i in range(3)]),
            Vector([max(p[i] for p in points) for i in range(3)]))


def clip_bottom(meshes, depth):
    if any(obj.type == 'ARMATURE' for obj in bpy.context.scene.objects):
        raise ValueError('Bottom clipping requires a static model; export a pose first')
    minimum, maximum = bounds(meshes)
    if depth >= maximum.z - minimum.z:
        raise ValueError('Bottom clipping would remove the whole model')
    plane = minimum.z + depth
    for obj in meshes:
        # 在世界坐标中裁切，使不同部件及原始节点变换使用同一平面。
        mesh = obj.data.copy()
        obj.data = mesh
        bm = bmesh.new()
        try:
            bm.from_mesh(mesh)
            bmesh.ops.transform(bm, matrix=obj.matrix_world, verts=list(bm.verts))
            result = bmesh.ops.bisect_plane(bm, geom=[*bm.verts, *bm.edges, *bm.faces],
                dist=1e-7, plane_co=(0, 0, plane), plane_no=(0, 0, 1), clear_inner=True)
            edges = [edge for edge in result['geom_cut'] if isinstance(edge, bmesh.types.BMEdge) and edge.is_boundary]
            if edges:
                bmesh.ops.holes_fill(bm, edges=edges, sides=0)
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bmesh.ops.transform(bm, matrix=obj.matrix_world.inverted(), verts=list(bm.verts))
            bm.to_mesh(mesh)
            mesh.update()
        finally:
            bm.free()


def transform_export(config):
    factor = float(config.get('scale_factor') or 1)
    pivot = config.get('pivot_to_center_bottom', False)
    flatten = config.get('flatten_bottom', False)
    if factor == 1 and not pivot and not flatten:
        return
    roots = [obj for obj in bpy.context.scene.objects if obj.parent is None]
    root = bpy.data.objects.new('AiModelingExportTransform', None)
    bpy.context.scene.collection.objects.link(root)
    for obj in roots:
        obj.parent = root
    # 父级缩放保留原动画轨道和骨架相对关系，不能逐网格烘焙后破坏蒙皮。
    root.matrix_world = Matrix.Scale(factor, 4)
    bpy.context.view_layer.update()
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    if flatten:
        clip_bottom(meshes, float(config.get('flatten_bottom_threshold') or 0.01))
        bpy.context.view_layer.update()
    if pivot:
        minimum, maximum = bounds(meshes)
        root.location = Vector((-(minimum.x + maximum.x) / 2, -(minimum.y + maximum.y) / 2, -minimum.z))
        bpy.context.view_layer.update()
