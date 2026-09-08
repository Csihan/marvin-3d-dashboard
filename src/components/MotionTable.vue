<script setup lang="ts">
/**
 * @file    MotionTable.vue
 * @brief   示教运动表：seq 自动编号、名称双击编辑、单行选择删除与回放
 * @author Csihan
 * @date    2026-08-28
 *
 * 组件职责：
 *   展示示教运动表（TeachPoint[]），支持以下操作：
 *   - seq 自动编号（从 1 开始，由行索引 +1 得到）；
 *   - 名称列支持双击编辑（contenteditable input），失焦或回车提交；
 *   - 单击行选中（高亮 + 通知父组件 selectedIndex）；
 *   - 操作按钮：单步执行（回放选中点）、删除选中。
 *
 * 表头列定义：
 *   seq | name | x | y | z | qw | qx | qy | qz | j1~j7 deg
 *   - 位置四元数（qw/qx/qy/qz）由 FK 正解填充（踩点时实时计算）；
 *   - 关节角（j1~j7）由 /joint_states 反馈实时填充。
 */
import { ref } from 'vue'
import type { TeachPoint } from '../types/robot'

/**
 * Props 定义。
 * @prop rows          - 当前运动表示教点数组
 * @prop selectedIndex  - 当前选中行索引（null 表示无选中）
 * @prop busy          - 忙碌状态锁（true 时禁用按钮）
 */
defineProps<{ rows: TeachPoint[]; selectedIndex: number | null; busy: boolean }>()

/**
 * I4（2026-09-05）：姿态明细（四元数 qw/qx/qy/qz）默认折叠。
 * 位置 x/y/z 是踩点核心信息，四元数在多数示教场景是冗余明细（FK 填充、供笛卡尔回放）；
 * 默认收起 → 表格 13 列只留"姿态"1 列占位（展开时 qw/qx/qy/qz 仍挤在 1 个单元格内），
 * 行数多时不横向溢出；需要时点表头「姿态」展开。
 */
const showQuat = ref(false)

/**
 * 事件定义：用户操作向上传递到 App.vue 处理。
 * @event select  - 选中某行（index: 行索引）
 * @event rename  - 重命名选中行（name: 新名称）
 * @event remove  - 删除当前选中行
 * @event replay  - 回放当前选中行
 * @event replayAll - minimum-jerk 整列连续回放（2026-09-04 M1 新增）
 */
const emit = defineEmits<{
  select: [index: number]
  rename: [name: string]
  remove: []
  replay: []
  replayAll: []
}>()

/** 当前正在编辑名称的行索引（null 表示无编辑态） */
const editingIndex = ref<number | null>(null)

/**
 * 提交名称编辑：失焦或回车时调用。
 * @param event  - 原始 DOM 事件（取 input.value）
 * @param current - 编辑前的原始名称（只有值变化时才触发 rename 事件）
 */
function commitRename(event: Event, current: string) {
  editingIndex.value = null
  const value = (event.target as HTMLInputElement).value.trim()
  // 只在名称实际变化时触发 rename 事件，避免无意义的空提交
  if (value !== current) emit('rename', value)
}
</script>

<template>
  <div class="motion-table">
    <!-- 操作按钮行：整列回放 + 单步执行 + 删除选中（2026-09-04 M1 加整列回放） -->
    <div class="table-actions">
      <button class="btn" :disabled="rows.length < 2 || busy" @click="emit('replayAll')">整列回放</button>
      <button class="btn" :disabled="selectedIndex === null || busy" @click="emit('replay')">单步执行</button>
      <button class="btn danger" :disabled="selectedIndex === null || busy" @click="emit('remove')">删除选中</button>
    </div>
    <!-- 滚动表格容器：max-height 限制高度，内容超长时纵向滚动 -->
    <div class="table-scroll">
      <table>
        <!-- 表头：seq(编号) name(名称) x/y/z + 姿态(默认折叠四元数) j1~j7(关节角)
             I4(2026-09-05)：姿态明细默认折叠，点「姿态」展开 qw/qx/qy/qz -->
        <thead>
          <tr>
            <th>seq</th><th>name</th><th>x</th><th>y</th><th>z</th>
            <th title="点击展开/收起四元数明细">
              <button class="quat-toggle" @click.stop="showQuat = !showQuat">姿态 {{ showQuat ? '▾' : '▸' }}</button>
            </th>
            <th v-for="i in 7" :key="i">j{{ i }}deg</th>
          </tr>
        </thead>
        <tbody>
          <!-- 逐行渲染：点击行选中，名称列双击进入编辑态 -->
          <tr v-for="(row, index) in rows" :key="index" :class="{ selected: index === selectedIndex }"
              @click="emit('select', index)">
            <td>{{ index + 1 }}</td>
            <td>
              <!-- 名称编辑器：readonly=false 时可编辑，失焦/回车提交 -->
              <input :value="row.name" :readonly="editingIndex !== index" placeholder="双击命名"
                     @dblclick="editingIndex = index"
                     @blur="commitRename($event, row.name)"
                     @keydown.enter="($event.target as HTMLInputElement).blur()" />
            </td>
            <!-- 位置列 x/y/z（始终显示，踩点核心信息） -->
            <td v-for="key in ['x','y','z']" :key="key">{{ Number(row[key as keyof TeachPoint]).toFixed(4) }}</td>
            <!-- 姿态列：默认折叠四元数（…占位），展开时显示 qw/qx/qy/qz -->
            <td v-if="showQuat">{{ ['qw','qx','qy','qz'].map(k => Number(row[k as keyof TeachPoint]).toFixed(4)).join(' ') }}</td>
            <td v-else class="quat-folded" title="点击「姿态」展开四元数">…</td>
            <!-- 关节角列：保留 1 位小数（deg） -->
            <td v-for="(angle, i) in row.j" :key="`j${i}`">{{ angle.toFixed(1) }}</td>
          </tr>
          <!-- 空态：无示教点时显示提示（表格恒 13 列：seq/name/x/y/z/姿态/j1~j7；
               I4 折叠的 qw/qx/qy/qz 只占"姿态"1 列，不影响 colspan） -->
          <tr v-if="!rows.length"><td colspan="13">暂无示教点</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
