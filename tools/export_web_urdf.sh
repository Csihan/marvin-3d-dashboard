#!/usr/bin/env bash
# ============================================================
# export_web_urdf.sh：整机 URDF + mesh 导出（Web 3D 大屏资产管线·通用模板）
# @file    export_web_urdf.sh
# @brief   xacro 展开整机模型并连同 STL mesh 拷贝到前端 public 目录
# @author  Csihan
# @date    2026-09-08
#
# 用法（ROS 环境内执行）：
#   1. 按你的工作空间改下方 ①②③ 三个路径变量与 XACRO_SRC 入口；
#   2. bash tools/export_web_urdf.sh
#
# 产物（本仓库 public/models/urdf/）：
#   robot.urdf          展开后的静态整机 URDF
#   meshes/<包名>/**    各源码包的 mesh（保留包名结构，与 package:// 一一对应）
#
# 说明（为什么需要这个管线）：
#   - 浏览器 URDFLoader 不解析 xacro 语法 → 必须先展开为静态 URDF；
#   - URDF 内 package:// 路径由前端 PACKAGE_MAP 映射到静态资源
#     （包名 → /models/urdf/meshes/<包名>，见 useRobot3D.ts 注释）；
#   - 拷贝后可在任意装 Python 的机器执行 tools/ascii_stl_to_binary.py
#     将 ASCII STL 转二进制（体积约减半，脚本自动跳过已二进制文件）。
# ============================================================
# 不用 set -u（ROS setup.bash 内部引用未定义变量会报错），错误即停用 -e 足够
set -eo pipefail

WS_ROOT="$HOME/ros_ws"                # ① ROS 工作空间根目录（示例值，按你的环境改）
SRC="$WS_ROOT/src"                    # ② 存放 xacro 与 mesh 的源码包目录
OUT="$WS_ROOT/marvin-3d-dashboard/public/models/urdf"   # ③ 本仓库的模型输出目录

# ROS 环境（xacro 需要；工作空间 devel/setup.bash 提供 $(find ...) 包路径解析）
source /opt/ros/noetic/setup.bash
source "$WS_ROOT/devel/setup.bash"    # 无 devel 环境时可注释本行，改为手动指定包路径

XACRO_SRC="$SRC/your_robot_description/urdf/robot.urdf.xacro"   # 你的整机 xacro 入口
PKG_NAME="your_robot_description"     # mesh 所在的 ROS 包名（= package:// 里的包名）

# 1) 展开整机 xacro → 静态 URDF（浏览器无法解析 xacro 语法）
mkdir -p "$OUT/meshes"
xacro "$XACRO_SRC" -o "$OUT/robot.urdf"

# 2) mesh 拷贝：保留 <pkg>/meshes... 目录结构，与 package:// 一一对应
rm -rf "$OUT/meshes/$PKG_NAME"
mkdir -p "$OUT/meshes/$PKG_NAME"
cp -r "$SRC/$PKG_NAME/meshes" "$OUT/meshes/$PKG_NAME/"

echo "EXPORT-OK: $OUT"
echo "下一步：在 src/composables/useRobot3D.ts 的 PACKAGE_MAP 登记 { $PKG_NAME: '/models/urdf/meshes/$PKG_NAME' }"