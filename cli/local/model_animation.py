"""预览动作与姿态证据；取样原片段时间，不把相机转台误记为骨骼播放。"""
import bpy
import hashlib
import json
import math
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view


def set_pose(scene, config, seconds, import_fps):
    animation = config.get('selected_animation')
    for obj in scene.objects:
        if obj.type == 'ARMATURE':
            obj.data.pose_position = 'POSE' if animation else 'REST'
    if not animation:
        bpy.context.view_layer.update()
        return None
    elapsed = config.get('animation_time', 0) + seconds * config.get('animation_speed', 1)
    duration = animation['duration']
    elapsed = elapsed % duration if config.get('animation_loop', True) else min(elapsed, duration)
    frame = (animation['start'] + elapsed) * import_fps
    scene.frame_set(math.floor(frame), subframe=frame % 1)
    bpy.context.view_layer.update()
    return elapsed


def bounds(meshes):
    graph = bpy.context.evaluated_depsgraph_get()
    points = [evaluated.matrix_world @ Vector(corner) for obj in meshes
              for evaluated in [obj.evaluated_get(graph)] for corner in evaluated.bound_box]
    minimum = Vector([min(p[i] for p in points) for i in range(3)])
    maximum = Vector([max(p[i] for p in points) for i in range(3)])
    return minimum, maximum


def frame_evidence(scene, camera, meshes, seconds, skeleton):
    joints, lines = [], []
    for obj in scene.objects:
        if obj.type != 'ARMATURE':
            continue
        for bone in obj.pose.bones:
            point = obj.matrix_world @ bone.head
            joints.append([bone.name, *[round(v, 6) for v in point]])
            if skeleton and bone.parent:
                parent = obj.matrix_world @ bone.parent.head
                projected = [world_to_camera_view(scene, camera, p) for p in (parent, point)]
                if all(p.z > 0 for p in projected):
                    lines.append([[round(p.x, 6), round(1-p.y, 6)] for p in projected])
    low, high = bounds(meshes)
    return {'animation_time': seconds,
            'pose_sha256': hashlib.sha256(json.dumps(joints, sort_keys=True).encode()).hexdigest(),
            'joints': len(joints), 'bounds': [list(low), list(high)], 'skeleton_lines': lines}
