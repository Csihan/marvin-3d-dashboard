<script setup lang="ts">
/**
 * @file    ControlPanel.vue
 * @brief   中央示教控制坞：模式操作 + 运动表编辑/回放
 * @author Csihan
 * @date    2026-08-28
 *
 * 组件职责：
 *   1. TeachModePanel：示教模式入口（臂选择、进入/退出协作释放 RELEASE、YAML 读写、CSV 导出）；
 *   2. MotionTable：运动表展示（seq 编号、名称编辑、选中/删除/回放）；
 *   3. 本组件只做组合（Slot-less 纯 Props 透传），不新增任何业务逻辑。
 *
 * 数据流：
 *   App.vue（useTeach）→ props.rows / selectedIndex → MotionTable 展示；
 *   MotionTable 事件（select/rename/remove/replay）→ emit → App.vue 处理。
 */
import MotionTable from './MotionTable.vue'
import TeachModePanel from './TeachModePanel.vue'
import type { TeachController } from '../composables/useTeach'
import type { TeachPoint } from '../types/robot'

/**
 * Props 定义（只读透传，本组件不做任何状态转换）。
 * @prop teach - 示教控制器实例（useTeach 返回值），提供 enterTeach/exitTeach 等方法
 * @prop rows - 当前运动表示教点数组（TeachPoint[]），由 useTeach.rows 管理
 * @prop selectedIndex - 当前选中行索引（null 表示无选中）
 * @prop busy - 忙碌状态锁（true 时禁用所有交互按钮，防止并发命令冲突）
 */
defineProps<{
  teach: TeachController
  rows: TeachPoint[]
  selectedIndex: number | null
  busy: boolean
}>()

/**
 * 事件定义：MotionTable 的用户操作向上传递到 App.vue 处理。
 * @event select   - 选中某行（index: 行索引）
 * @event rename   - 重命名某行（name: 新名称，双击编辑后回车触发）
 * @event remove   - 删除当前选中行（无参数）
 * @event replay   - 回放当前选中行（无参数，App 侧调用 teach.replayStep）
 */
const emit = defineEmits<{
  select: [index: number]
  rename: [name: string]
  remove: []
  replay: []
}>()
</script>

<template>
  <!-- 中央示教控制坞：TeachModePanel（操作入口）+ MotionTable（运动表）纵向排列 -->
  <section class="control-panel">
    <!-- 示教模式面板：臂选择、进入/退出协作释放 RELEASE、YAML 保存/加载、CSV 导出、动作库导出 -->
    <TeachModePanel :teach="teach" :busy="busy" />
    <!-- 运动表：seq 自动编号、名称双击编辑、选中/删除/回放按钮 -->
    <MotionTable :rows="rows" :selected-index="selectedIndex" :busy="busy"
                 @select="index => emit('select', index)" @rename="name => emit('rename', name)"
                 @remove="emit('remove')" @replay="emit('replay')" />
  </section>
</template>
