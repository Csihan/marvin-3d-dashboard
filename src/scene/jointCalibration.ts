/**
 * @file    jointCalibration.ts
 * @brief   每臂独立的关节方向校准表——修正 URDF 模型与真机的旋转方向差异
 * @author Csihan
 * @date    2026-09-03
 *
 * 背景：
 *   URDF 左右臂定义完全相同（arm_left.xacro ≡ arm_right.xacro），但真机双臂
 *   对向安装（左臂+Y朝右、右臂+Y朝左），导致模型显示的旋转方向与真机相反。
 *   本模块提供校准表和查询函数，在所有 setJointValues 调用点统一使用。
 *
 * ⚠ 基准变更（2026-09-04 方案 B，见 orientation.ts 文件头）：
 *   机器人朝向渲染已从「rotation.y=π + scale.z=-1 镜像」改为 URDF 原生
 *   X+ 朝前（单一事实源 scene/orientation.ts）。模型侧基准改变后，
 *   INVERT_JOINTS 表需要真机重新对照核验一遍——旧表项是在"镜像基准"
 *   下标定的，可能整体取反。维护流程不变（dbg_hw_stagec.py 逐关节对照）。
 *
 * 使用方式：
 *   - 在 drag.ts / useRobot3D.ts / ik.ts 的 setJointValues 调用前，
 *     对模型侧角度取反：shouldInvert(side, baseName) ? -angle : angle
 *   - 命令侧（发给真机的角度）不取反——真机方向是正确的。
 *
 * 维护流程：
 *   scripts/dbg_hw_stagec.py 慢速 J1~J7 ±5° 单关节点动对照，
 *   把实测方向与模型相反的关节基名+臂侧加进 INVERT_JOINTS 表。
 */

/**
 * 每臂独立的方向校准表。
 * key = 关节基名（如 'Joint1'），value = 需要取反的臂集合。
 *
 * ⚠ 表已归零（2026-09-04）：模型摆放改为纯旋转 MODEL_YAW=π（不再有
 * scale.z=-1 镜像基准），旧表项（右臂 J1/J3）是镜像基准下的产物,整体作废。
 * 真机重标流程：scripts/dbg_hw_stagec.py 慢速 J1~J7 ±5° 单关节点动,
 * 实测方向与模型相反的关节填回本表（左右臂独立标定）。
 */
export const INVERT_JOINTS: Record<string, Set<'L' | 'R'>> = {
  // 待真机重标（2026-09-04 基准变更后清空）
}

/**
 * 查询指定臂的指定关节是否需要在模型侧取反。
 *
 * @param side           臂侧 'L' | 'R'
 * @param jointBaseName  关节基名（如 'Joint1'，不含 _L/_R 后缀）
 * @returns true = 模型侧角度需取反（命令侧不取反）
 */
export function shouldInvert(side: 'L' | 'R', jointBaseName: string): boolean {
  return INVERT_JOINTS[jointBaseName]?.has(side) ?? false
}
