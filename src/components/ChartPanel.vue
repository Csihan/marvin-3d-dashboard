<script setup lang="ts">
/**
 * @file    ChartPanel.vue
 * @brief   双臂 J2 实时曲线；数据更新在 App，ECharts 生命周期由本组件管理。
 * @author Csihan
 * @date    2026-08-28
 *
 * 组件职责：
 *   展示左右臂 J2（肩部抬臂）关节角度实时波形图（ECharts 折线图）。
 *   数据由 App.vue 的 chartTimer（500ms 间隔）定时采集并写入 props；
 *   本组件只负责 ECharts 实例的创建、更新与销毁。
 *
 * 图表配置：
 *   - X 轴：时间标签（HH:MM 格式，保留最近 30 个采样点）；
 *   - Y 轴：角度（°），范围 -180°~180°；
 *   - 左 J2 蓝色实线，右 J2 浅蓝实线，smooth 曲线；
 *   - 背景透明，网格线极淡，不干扰 HUD 风格。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts'

/**
 * Props 定义。
 * @prop left   - 左臂 J2 角度历史数组（rad，组件内转 deg 显示）
 * @prop right  - 右臂 J2 角度历史数组（rad）
 * @prop labels - 时间标签数组（'HH:MM' 格式，与 left/right 等长）
 */
const props = defineProps<{ left: number[]; right: number[]; labels: string[] }>()

/** ECharts DOM 容器引用 */
const chartRef = ref<HTMLDivElement | null>(null)

/** ECharts 实例（onMounted 创建，onBeforeUnmount 销毁） */
let chart: echarts.ECharts | null = null

onMounted(() => {
  if (!chartRef.value) return
  // 初始化 ECharts 实例：透明背景融入 HUD 深色主题
  chart = echarts.init(chartRef.value)
  // 设置初始选项：折线图 + 双系列（左J2/右J2）+ 自定义配色
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { top: 24, right: 14, bottom: 20, left: 34 },
    xAxis: { type: 'category', data: [], axisLine: { lineStyle: { color: '#1a3a5c' } }, axisLabel: { show: false } },
    yAxis: { type: 'value', min: -180, max: 180, axisLabel: { color: '#4a7a9a', fontSize: 9 }, splitLine: { lineStyle: { color: 'rgba(49,176,230,.06)' } } },
    series: [
      { name: '左J2', type: 'line', data: [], smooth: true, symbol: 'none', lineStyle: { color: '#31b0e6', width: 2 } },
      { name: '右J2', type: 'line', data: [], smooth: true, symbol: 'none', lineStyle: { color: '#93c5fd', width: 2 } },
    ],
    legend: { data: ['左J2', '右J2'], textStyle: { color: '#4a7a9a', fontSize: 10 }, top: 0 },
  })
  // 监听窗口 resize，ECharts 自动适配容器尺寸
  window.addEventListener('resize', resize)
})

/** 窗口 resize 时同步调整图表尺寸 */
function resize() { chart?.resize() }

/**
 * 监听 props 数据变化，实时更新图表数据。
 * deep: true 确保数组内部变化也能触发更新（数组长度变化时 ECharts 自动追加/裁剪点）。
 */
watch(() => [props.left, props.right, props.labels], () => {
  chart?.setOption({ xAxis: { data: props.labels }, series: [{ data: props.left }, { data: props.right }] })
}, { deep: true })

onBeforeUnmount(() => {
  // 清理：移除 resize 监听 + 销毁 ECharts 实例（防内存泄漏）
  window.removeEventListener('resize', resize)
  chart?.dispose()
})
</script>

<template>
  <section class="chart-panel">
    <!-- 标题栏 -->
    <div class="panel-title">实时位置曲线</div>
    <!-- ECharts 图表容器：ref 绑定用于 onMounted 初始化 -->
    <div ref="chartRef"></div>
  </section>
</template>
