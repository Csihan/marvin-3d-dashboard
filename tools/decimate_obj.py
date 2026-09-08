#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
decimate_obj.py：大 OBJ 减面 + 单位换算 + GLB 输出

@file    decimate_obj.py
@brief   流式读取大 OBJ 文件，抽样减面 + mm→m 单位换算，输出轻量 OBJ
@author Csihan
@date    2026-08-27

用法:
    python tools/decimate_obj.py <input.obj> [output.obj] [ratio]

参数说明:
    input.obj  - 输入 OBJ 文件路径（如 728MB 原始高精度模型）
    output.obj - 输出 OBJ 文件路径（默认 robot_dec.obj）
    ratio      - 保留比例（默认 0.03 = 保留 3% 面）

原理:
    1. 流式逐行读取 OBJ（避免全量加载 OOM）；
    2. 每隔 1/ratio 个面保留 1 个（抽样减面，非精确拓扑优化）；
    3. 顶点缓存 + 懒清理（每 50 万面清理一次，超 200 万顶点强制清）；
    4. 单位换算：mm → m（÷1000），输出供 assimp/Blender 转 GLB。

限制:
    - 抽样减面不保证拓扑一致性（面法线可能翻转），适合预览/评估；
    - 精确减面请用 blender_decimate.py（Quadric Edge Collapse）。
"""
import sys
import os

# ─── 命令行参数解析 ───
# 输入文件路径（必需参数）
INPUT = sys.argv[1] if len(sys.argv) > 1 else "model.obj"
# 输出文件路径（可选，默认 robot_dec.obj）
OUTPUT = sys.argv[2] if len(sys.argv) > 2 else "robot_dec.obj"
# 保留比例（可选，默认 0.03 = 保留 3% 的面）
FACE_KEEP_RATIO = float(sys.argv[3]) if len(sys.argv) > 3 else 0.03  # 保留 3%


def main():
    """主函数：流式读取 OBJ 文件，按比例抽样减面后输出新 OBJ。

    处理流程：
      1. 逐行读取输入 OBJ 文件（避免大文件 OOM）；
      2. 遇到 "v " 行时缓存顶点坐标；
      3. 遇到 "f " 行时按比例决定是否保留该面；
      4. 保留的面引用的顶点自动收集并重编号；
      5. 每处理 50 万面检查一次缓存大小，超 200 万顶点时强制清理（防 OOM）；
      6. 最终输出精简后的 OBJ 文件（顶点单位 mm→m）。
    """
    # in_v / in_f：标记当前是否在顶点/面定义块内（OBJ 用 "v"/"f" 前缀标识）
    in_v = False
    in_f = False
    v_idx_map = {}       # 原始顶点索引 → 新索引的映射表
    new_v_idx = 0        # 新顶点编号计数器
    face_count = 0       # 已读取的面总数
    kept_faces = []      # 保留的面列表（每个元素是顶点索引数组）
    kept_verts = []      # 保留的顶点列表（每个元素是 (原始索引, x, y, z)）
    vert_cache = {}      # 顶点暂存缓存（原始索引 → (x,y,z)），用后清理

    print(f"Reading {INPUT} ...")
    with open(INPUT, "r", encoding="utf-8", errors="ignore") as fin:
        for line in fin:
            if line.startswith("v "):
                # ─── 解析顶点行：格式 "v x y z" ───
                parts = line.split()
                # 顶点索引 = 已缓存数 + 已映射数 + 1（OBJ 索引从 1 开始）
                idx = len(vert_cache) + len(v_idx_map) + 1
                # 暂存到 vert_cache（延迟到被面引用时才正式收录）
                vert_cache[idx] = (float(parts[1]), float(parts[2]), float(parts[3]))

            elif line.startswith("f "):
                # ─── 解析面行：格式 "f v1/vt1/vn1 v2/... v3/..." ───
                face_count += 1
                # 抽样逻辑：每隔 1/ratio 个面保留 1 个
                if face_count % int(1 / FACE_KEEP_RATIO) == 0:
                    # 保留这个面
                    tokens = line.split()[1:]
                    vert_ids = []
                    for t in tokens:
                        # 从 "v/vt/vn" 格式中提取顶点索引 v
                        vi = int(t.split("/")[0])
                        vert_ids.append(vi)
                        if vi not in v_idx_map:
                            # 新顶点：从缓存中取出并收录
                            if vi in vert_cache:
                                x, y, z = vert_cache[vi]
                                kept_verts.append((vi, x, y, z))
                                v_idx_map[vi] = new_v_idx
                                new_v_idx += 1
                            else:
                                # 顶点缓存在大文件时可能已被清理，直接跳过该面
                                vert_ids = []
                                break
                    if len(vert_ids) >= 3:
                        # 有效面（至少 3 个顶点）→ 收录
                        kept_faces.append(vert_ids)

                # ─── 定期清理顶点缓存防 OOM ───
                if face_count % 500000 == 0:
                    print(f"  faces: {face_count}, kept: {len(kept_faces)}, verts cached: {len(vert_cache)}")
                    if len(vert_cache) > 2000000:
                        # 超过 200 万顶点 → 强制清理（后续被引用的面会跳过）
                        vert_cache.clear()

    # ─── 输出统计 ───
    print(f"Total faces: {face_count}")
    print(f"Kept faces:  {len(kept_faces)}")
    print(f"Used verts:  {len(v_idx_map)}")

    # ─── 写输出文件 ───
    print(f"Writing {OUTPUT} ...")
    with open(OUTPUT, "w") as fout:
        fout.write("# Decimated by decimate_obj.py\n")
        fout.write("# Units: meters (from mm /1000)\n")
        # 构建原始顶点索引 → 新输出索引的映射（1-based）
        idx_to_new = {vi: ni for ni, (vi, _, _, _) in enumerate(kept_verts, 1)}
        # 写顶点（mm → m 单位换算：÷1000）
        for vi, x, y, z in kept_verts:
            fout.write(f"v {x/1000:.6f} {y/1000:.6f} {z/1000:.6f}\n")
        # 写面（使用新索引重新编号）
        for fv in kept_faces:
            new_ids = [str(idx_to_new.get(vi, 1)) for vi in fv]
            fout.write(f"f {' '.join(new_ids)}\n")

    # 输出文件大小
    out_size = os.path.getsize(OUTPUT) / 1024 / 1024
    print(f"Done! Output: {out_size:.1f} MB")


# ─── 脚本入口 ───
if __name__ == "__main__":
    main()
