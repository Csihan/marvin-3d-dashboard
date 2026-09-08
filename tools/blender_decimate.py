"""
blender_decimate.py — Blender headless 脚本
导入 OBJ → Decimate 保留拓扑 → 导出 GLB

@file    blender_decimate.py
@brief   Blender 无头模式减面：OBJ 导入 → Quadric Edge Collapse Decimate → GLB 导出
@author Csihan
@date    2026-08-27

用法（需 Blender 3.x+）:
    blender --background --python blender_decimate.py -- <input.obj> <output.glb> <ratio>

参数说明:
    input.obj  - 输入 OBJ 文件路径（原始高精度模型，单位 mm）
    output.glb - 输出 GLB 文件路径
    ratio      - 减面比例（0.05 = 保留 5% 的面，1478万 → 74万面）

原理:
    1. bpy.ops.wm.read_factory_settings(use_empty=True) 清空默认场景；
    2. 导入 OBJ（bpy.ops.import_scene.obj）；
    3. 合并所有 mesh 为一个（减少 draw call）；
    4. 应用 DECIMATE 修改器（Quadric Edge Collapse，保留拓扑）；
    5. 单位 mm → m（OBJ 标注为 mm，URDF 使用米）；
    6. 导出 GLB（glTF 二进制格式，体积小、加载快）。
"""
import bpy
import sys

# ─── 解析命令行参数（Blender 脚本模式下参数在 "--" 之后）───
argv = sys.argv[sys.argv.index("--") + 1:]
# 输入 OBJ 文件路径（必需）
input_obj = argv[0]
# 输出 GLB 文件路径（必需）
output_glb = argv[1]
# 减面比例（可选，默认 0.05 = 保留 5% 的面）
ratio = float(argv[2]) if len(argv) > 2 else 0.05

# 打印本次运行参数
print(f"=== Blender Decimate ===")
print(f"Input: {input_obj}")
print(f"Output: {output_glb}")
print(f"Ratio: {ratio}")

# ─── Step 1：清空 Blender 默认场景（避免场景中残留 Cube/Camera/Light）───
# use_empty=True 创建空场景，不包含任何默认对象
bpy.ops.wm.read_factory_settings(use_empty=True)

# ─── Step 2：导入 OBJ 文件 ───
# 对于大文件（数百 MB），导入可能需要几分钟
print("Importing OBJ (this may take a few minutes for large files)...")
bpy.ops.import_scene.obj(filepath=input_obj)
print("Import done.")

# ─── Step 3：统计导入后的总面数 ───
# 遍历场景中所有 MESH 类型对象，累加 polygon 数量
total_faces = sum(len(obj.data.polygons) for obj in bpy.context.scene.objects if obj.type == 'MESH')
print(f"Total faces: {total_faces}")

# ─── Step 4：合并所有 mesh 为一个（减少 GPU draw call，提升渲染性能）───
# 先全选所有对象，再设活动对象，最后执行 join
bpy.ops.object.select_all(action='SELECT')
bpy.context.view_layer.objects.active = bpy.context.selected_objects[0]
bpy.ops.object.join()

# ─── Step 5：应用 Decimate 修改器（Quadric Edge Collapse 减面算法）───
# Quadric Edge Collapse 是保拓扑的减面方法，比抽样减面更精确
obj = bpy.context.active_object
# 创建 DECIMATE 修改器（名称 "Decimate"）
mod = obj.modifiers.new(name="Decimate", type='DECIMATE')
# 设置减面比例：0.05 = 保留 5% 的面
mod.ratio = ratio
# 使用三角化折叠（将多边形面折叠为三角形，避免 N-gon 问题）
mod.use_collapse_triangulate = True

# ─── Step 6：应用修改器（将修改器效果烘焙到 mesh 数据）───
bpy.context.view_layer.objects.active = obj
bpy.ops.object.modifier_apply(modifier="Decimate")

# ─── Step 7：统计减面后的面数 ───
final_faces = len(obj.data.polygons)
print(f"After decimate: {final_faces} faces ({ratio*100:.0f}%)")

# ─── Step 8：单位换算 mm → m（OBJ 标注为 mm，URDF 使用米）───
# 缩放 0.001 倍 = ÷1000
obj.scale = (0.001, 0.001, 0.001)
# 应用缩放到 mesh 数据（否则导出的 GLB 仍是 mm 单位）
bpy.ops.object.transform_apply(scale=True)

# ─── Step 9：导出 GLB（glTF Binary 格式）───
# GLB 是 glTF 的二进制打包格式，体积小、加载快，Three.js 原生支持
print(f"Exporting GLB...")
bpy.ops.export_scene.gltf(
    filepath=output_glb,
    export_format='GLB',      # 二进制格式（非分离的 .gltf + .bin）
    export_apply=True,         # 应用所有修改器后导出
)

# ─── Step 10：输出文件大小统计 ───
import os
size_mb = os.path.getsize(output_glb) / 1024 / 1024
print(f"Done! Output: {output_glb} ({size_mb:.1f} MB)")
