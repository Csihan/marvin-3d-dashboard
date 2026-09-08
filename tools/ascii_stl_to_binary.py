#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ascii_stl_to_binary.py：批量 ASCII STL → 二进制 STL 转换（Web 模型加载提速）。

@file    ascii_stl_to_binary.py
@brief   将 ASCII STL 转为二进制格式，体积约减半、解析提速（THREE.STLLoader 两种都支持）
@author Csihan
@date    2026-08-28

用法（Windows 侧，标准库即可，无第三方依赖）：
    python tools/ascii_stl_to_binary.py public/models/urdf

原理：
    ASCII STL 每个三角形约 250 字节文本（facet normal/vertex x7 行），
    二进制 STL 固定 50 字节/三角形（80B 头 + uint32 数量 + 12f + uint16）。
    逐文件流式解析，"facet normal"/"vertex" 行捕获浮点，enclosure 无损；
    已是二进制的文件（首 5 字节非 "solid" 或含非文本字节）自动跳过。
"""
import math
import struct
import sys
from pathlib import Path


def is_ascii_stl(path: Path) -> bool:
    """判断是否 ASCII STL：二进制 STL 头 80 字节常含非文本字节或长度不合规律。

    二进制 STL 格式约定：
      - 前 80 字节为注释头（可含任意字节）；
      - 第 81~84 字节为 uint32 小端三角形数量 n；
      - 随后 n × 50 字节 = 每三角形 (12f + uint16)；
      - 总文件大小 = 84 + 50 × n。
    因此判断逻辑：先检查首 5 字节是否为 "solid"（ASCII STL 标志），
    再验证文件大小是否严格等于 84 + 50 × n（二进制特征）。
    """
    try:
        with open(path, "rb") as f:
            # 读取文件头 80 字节（二进制格式的注释区）
            head = f.read(80)
        # 二进制格式也有以 "solid" 开头的写法，需进一步用文件大小验证：
        # size == 84 + 50 * n_tri 才是二进制
        size = path.stat().st_size
        if head.lstrip().startswith(b"solid"):
            # 读取三角形数量（第 80~84 字节，uint32 小端）
            if size >= 84:
                n_tri = struct.unpack("<I", head[:0] or _read_at(path, 80, 4))[0]
                # 文件大小严格匹配二进制格式 → 是二进制 STL
                if size == 84 + 50 * n_tri:
                    return False
            # 大小不匹配 → 是 ASCII STL
            return True
        # 首 5 字节不是 "solid" → 一定是二进制
        return False
    except OSError:
        # 读取失败时保守返回 False（跳过该文件）
        return False


def _read_at(path: Path, offset: int, length: int) -> bytes:
    """从文件指定偏移量读取指定长度的字节（用于读取二进制 STL 头部的三角形计数字段）。

    @param path    文件路径。
    @param offset  起始偏移量（字节，0-based）。
    @param length  要读取的字节数。
    @return        读取到的字节数据。
    """
    with open(path, "rb") as f:
        f.seek(offset)
        return f.read(length)


def convert_file(path: Path) -> tuple:
    """转换单个 ASCII STL → 同名二进制 STL（就地替换）。

    @param path  ASCII STL 文件路径。
    @return      (三角形数, 原始文件大小, 新文件大小) 三元组。

    转换流程：
      1. 逐行读取 ASCII STL，解析 "facet normal" 和 "vertex" 行；
      2. 每遇到 "endfacet"，将法向量 + 3 个顶点打包为 12 个 float + 1 个 uint16 属性；
      3. 先写入临时文件（.stl.tmp），回填三角形数量后原子替换原文件。
    """
    normals = []   # 当前 facet 法向量（暂存到遇到 3 个 vertex 后写出）
    verts = []     # 当前 facet 的 3 个顶点坐标
    tris = 0       # 已处理的三角形计数
    tmp = path.with_suffix(".stl.tmp")  # 临时输出文件（完成后原子替换原文件）
    with open(path, "r", errors="replace") as fin, \
         open(tmp, "wb") as fout:
        # 写入 80 字节全零头（二进制 STL 标准头部，内容不影响加载）
        fout.write(b"\0" * 80)
        # 写入三角形数量占位（4 字节 uint32，末尾回填真实值）
        fout.write(struct.pack("<I", 0))
        for line in fin:
            s = line.strip()
            if s.startswith("facet normal"):
                # 解析法向量：格式 "facet normal nx ny nz"，取最后 3 个浮点数
                normals.append([float(x) for x in s.split()[2:5]])
            elif s.startswith("vertex"):
                # 解析顶点：格式 "vertex x y z"，取后 3 个浮点数
                verts.append([float(x) for x in s.split()[1:4]])
            elif s.startswith("endfacet"):
                # 一个 facet = 法向量 + 3 顶点，打包为 12 float + 1 uint16 属性
                # 12f = nx ny nz v1x v1y v1z v2x v2y v2z v3x v3y v3z
                # H = 属性字节计数（通常为 0）
                if len(normals) != 1 or len(verts) != 3:
                    raise ValueError(f"{path}: facet 解析异常 "
                                     f"(n={len(normals)}, v={len(verts)})")
                data = normals[0] + verts[0] + verts[1] + verts[2]
                fout.write(struct.pack("<12fH", *data, 0))
                tris += 1
                # 清空暂存区，准备解析下一个 facet
                normals.clear()
                verts.clear()
        # 回填真实三角形数量（覆盖开头的占位 0）
        fout.seek(80)
        fout.write(struct.pack("<I", tris))
    # 获取新旧文件大小用于统计
    old, new = path.stat().st_size, tmp.stat().st_size
    # 原子替换：用临时文件覆盖原文件（rename 在同一文件系统下是原子操作）
    tmp.replace(path)
    return tris, old, new


def main() -> int:
    """主入口：递归扫描目录下所有 STL 文件，将 ASCII 格式转为二进制格式。

    @return  0=成功（含跳过的二进制文件），1=未找到 STL 文件。

    处理流程：
      1. 递归扫描指定目录下所有 .stl / .STL 文件；
      2. 对每个文件判断是否为 ASCII 格式（is_ascii_stl）；
      3. ASCII 格式则执行转换（convert_file），二进制格式则跳过；
      4. 输出每个文件的转换结果和总体体积缩减比例。
    """
    # 获取输入目录（命令行参数，默认当前目录）
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    # 递归扫描所有 .stl 和 .STL 文件（大小写敏感，覆盖不同系统的命名习惯）
    stls = sorted(root.rglob("*.stl")) + sorted(root.rglob("*.STL"))
    if not stls:
        print(f"no stl found under {root}")
        return 1
    # 统计总量
    total_old = total_new = 0
    for p in stls:
        if not is_ascii_stl(p):
            # 已经是二进制格式，跳过
            print(f"[skip-binary] {p.name}")
            continue
        # 执行转换并统计
        tris, old, new = convert_file(p)
        total_old += old
        total_new += new
        print(f"[ok] {p.name}: {tris} tris, "
              f"{old / 1e6:.1f}MB -> {new / 1e6:.1f}MB")
    # 输出总体缩减比例
    if total_old:
        print(f"total: {total_old / 1e6:.1f}MB -> {total_new / 1e6:.1f}MB "
              f"({total_new / total_old * 100:.0f}%)")
    return 0


# ─── 脚本入口：直接运行时调用 main() ───
if __name__ == "__main__":
    sys.exit(main())
