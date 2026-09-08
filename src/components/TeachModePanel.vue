<script setup lang="ts">
/**
 * @file    TeachModePanel.vue
 * @brief   示教入口：两种任务模式（键盘踩点/人手拖动）、RELEASE 安全确认、采样与文件读写控制
 * @author Csihan
 * @date    2026-08-28
 *
 * 组件职责：
 *   1. 臂选择：左臂(arm_L) / 右臂(arm_R) 下拉切换；
 *   2. 进入/退出示教（2026-09-06 收敛为 2 个任务模式，TEACH-MODE-CONVERGE-20260906）：
 *      ①「进入示教」= 键盘踩点（默认，一键进入零选择，位置模式指令流，无末端按钮前提）；
 *      ②「人手拖动 ▾」= 子选项（关节/XYZ/RPY/协作释放）以对应拖动空间进 SDK 拖动就绪态；
 *   3. 手动记点：在采样过程中手动补一个关键帧；
 *   4. 文件操作：YAML 保存/加载、CSV 导出、动作库 JSON 导出；
 *   5. 采样状态指示：● 采样中 / ○ 未采样。
 *
 * 安全口径（SIMULATION_ONLY 硬边界）：
 *   键盘踩点不发 mode_switch state=4（臂留在位置模式）；人手拖动 = 该臂切 M4
 *   （state=4 + drag_space），3D 腕端出现琥珀拖动环、必须按住末端按钮才真正拖动；
 *   真机阶段必须在单独变更中设计授权、互锁和现场确认。
 *
 * 2026-09-05（手册审查 A1/A2）：M4 命名统一「协作释放(RELEASE)」（手册 §2.6 state=4）；
 *   拖动执行前提补「按住末端按钮才真正拖动，松开即停」（手册 §5.6/§12.6 m_TipDI==1）。
 * 2026-09-06（TEACH-MODE-CONVERGE）：删除常驻「拖动方式」下拉（4 项平铺与"进入示教"
 *   主操作竞争注意力，操作员认知负担大）——主按钮只保留键盘踩点，人手拖动收进
 *   「人手拖动 ▾」子菜单（点子项即以该拖动空间进入，无需二次确认按键）。
 */
import { ref, onBeforeUnmount } from 'vue'
import type { TeachController } from '../composables/useTeach'

/**
 * Props 定义。
 * @prop teach - 示教控制器实例（useTeach 返回值，提供 enterTeach/enterTeachKeyboard/exitTeach 等）
 * @prop busy  - 忙碌状态锁（true 时禁用按钮，防止并发命令）
 */
const props = defineProps<{ teach: TeachController; busy: boolean }>()

/** 「人手拖动 ▾」子菜单展开态（局部 UI 态，不进控制器；展开中点击外部收起） */
const dragMenuOpen = ref(false)
/** 子菜单收起定时器：延迟收起留出"从按钮移到菜单项"的间隙，防误关 */
let dragMenuTimer: ReturnType<typeof setTimeout> | null = null

/** 展开人手拖动子菜单（悬停/点击均可；先清掉待收起定时器） */
function openDragMenu(): void {
  if (dragMenuTimer) { clearTimeout(dragMenuTimer); dragMenuTimer = null }
  dragMenuOpen.value = true
}
/** 请求收起子菜单：延迟 120ms 执行，期间再次悬停会取消（mousebridging 手感） */
function scheduleCloseDragMenu(): void {
  if (dragMenuTimer) clearTimeout(dragMenuTimer)
  dragMenuTimer = setTimeout(() => { dragMenuOpen.value = false }, 120)
}
/** 立即收起（选中子项后调用，不留延迟） */
function closeDragMenu(): void {
  if (dragMenuTimer) { clearTimeout(dragMenuTimer); dragMenuTimer = null }
  dragMenuOpen.value = false
}
// 组件卸载时清定时器，防止对已卸载组件的回调触发（内存泄漏防护）
onBeforeUnmount(() => { if (dragMenuTimer) clearTimeout(dragMenuTimer) })

/**
 * 进入示教——键盘踩点模式（任务模式①，默认主按钮）：
 * 不切拖动态、不弹安全确认（臂不进 M4，无零力/无释放风险，确认弹窗只会稀释
 * "人手拖动才需要现场确认"的警示强度）；一键进入零选择，teaching=true + 采样照常。
 */
async function enterKeyboard() {
  // 2026-09-06（TEACH-MODE-CONVERGE）：enterTeachKeyboard 不发 mode_switch state=4——
  // 键盘 Jog 走位置模式指令流（与 ArmPanel 滑条同通道），无需 SDK 拖动就绪态。
  await props.teach.enterTeachKeyboard()
}

/**
 * 进入示教——人手拖动模式（任务模式②，子菜单选择拖动空间）：
 * @param space set_drag 拖动空间（1=关节 2=XYZ 平移 3=RPY 旋转 6=协作释放零力悬浮）。
 * 弹安全确认（文案按拖动空间区分），确认后走既有 enterTeach(space)——协议序列
 * mode_switch state=4 + drag_space 完全不变（comms 一站式走 /arm/set_drag）。
 */
async function enterDragWithConfirm(space: number) {
  closeDragMenu()
  const sideName = props.teach.side.value === 'arm_L' ? '左臂' : '右臂'
  // 2026-09-01（真机 M4 事故整改）：文案与实际行为对齐——关节阻抗拖动
  //（臂保持力矩可徒手拖），不再误称"零力 RELEASE"；真机保留双重确认口径。
  // 2026-09-02：文案按拖动空间区分——6=零力 RELEASE（重力补偿悬浮、松手即停），
  // 1~5=阻抗拖动（臂保持力矩、有回中力）。
  // 2026-09-05（手册 §5.6/§12.6）：补"按住末端按钮才真正拖动，松开即停"执行前提。
  // 2026-09-06（TEACH-MODE-CONVERGE）：人手拖动四子项统一口径——都必须按住末端
  // 按钮 m_TipDI==1 才真正拖动；键盘踩点（主按钮）无需末端按钮，两模式在确认弹窗
  // 层面明确区分（验收 4）。
  const spaceName = space === 6
    ? '协作释放（零力悬浮）'
    : space === 1 ? '关节拖动' : space === 2 ? 'XYZ 平移' : 'RPY 旋转'
  if (!window.confirm(`即将进入 ${sideName} ${spaceName}（人手拖动，SDK 拖动就绪态）。\n⚠️ 必须按住末端按钮（m_TipDI==1）才真正拖动，松开即停；键盘踩点无需末端按钮。\n请确认臂完全静止、无人处于危险区域。`)) return
  await props.teach.enterTeach(space)
}
</script>

<template>
  <section class="teach-panel">
    <!-- 标题 -->
    <div class="panel-title">示教</div>
    <!-- 操作区(2026-09-06 收敛):主按钮行(两任务模式+记点) → 文件操作一行 -->
    <!-- 2026-09-06 TEACH-MODE-CONVERGE 交互收敛(任务单):
         ① 删除常驻「拖动方式」下拉——4 项拖动空间平铺(关节/XYZ/RPY/协作释放)与
            「进入示教」竞争注意力,操作员每次进示教都要先理解 4 个技术选项;
         ② 「进入示教」= 键盘踩点(默认):一键进入零选择,primary 强调最高频主操作;
         ③ 「人手拖动 ▾」= secondary,展开 4 子项(关节/XYZ/RPY/协作释放),
            点子项即以该拖动空间进入(确认弹窗仍拦截,安全兜底不变);
         ④ 示教中主按钮变「退出示教」+「手动记一点」,臂/拖动空间选择禁用(防中途换)。 -->
    <div class="controls">
      <!-- 主操作行:进入示教(键盘踩点) / 人手拖动▾ / 手动记一点 -->
      <div class="ctl-row main-row">
        <!-- 任务模式①:键盘踩点(默认)。未示教时显示;teaching 中被「退出示教」替换 -->
        <button v-if="!teach.teaching.value" class="btn primary" :disabled="busy"
                title="键盘踩点:一键进入,无需末端按钮——W/S/A/D/R/F/Q/E 六轴、1/2/3 切步长"
                @click="enterKeyboard">进入示教</button>
        <!-- 示教中:退出按钮(两模式共用;协议退出序列一致,文案按模式区分) -->
        <button v-else class="btn danger" :disabled="busy" @click="teach.exitTeach()">退出示教</button>
        <!-- 任务模式②:人手拖动(secondary,悬停/点击展开子菜单;示教中隐藏——
             进入方式已定,中途不允许混用,退出后可再选) -->
        <span v-if="!teach.teaching.value" class="dragmenu-wrap"
              @mouseenter="openDragMenu" @mouseleave="scheduleCloseDragMenu">
          <button class="btn" :disabled="busy"
                  @click="dragMenuOpen ? scheduleCloseDragMenu() : openDragMenu()">人手拖动 ▾</button>
          <!-- 子菜单:4 个拖动空间(与原下拉同口径);点子项=以该 space 进人手拖动 -->
          <span v-if="dragMenuOpen" class="dragmenu" @mouseenter="openDragMenu" @mouseleave="scheduleCloseDragMenu">
            <button class="dm-item" :disabled="busy" title="臂保持力矩,人手可推动任一关节,松手保持——适合关节空间粗调构型"
                    @click="enterDragWithConfirm(1)">关节拖动（人手掰关节）</button>
            <button class="dm-item" :disabled="busy" title="人手沿 X 轴推拉末端,其余方向锁死——适合对准门把手等单方向对位"
                    @click="enterDragWithConfirm(2)">XYZ 平移（人手推拉末端）</button>
            <button class="dm-item" :disabled="busy" title="人手旋转末端姿态,位置锁死——适合调工具朝向"
                    @click="enterDragWithConfirm(3)">RPY 旋转（人手拧姿态）</button>
            <button class="dm-item" :disabled="busy" title="零力漂浮:重力补偿后臂悬浮,人手拖到哪停到哪;必须按住末端按钮才动——适合自由摆位/碰撞脱离"
                    @click="enterDragWithConfirm(6)">协作释放（零力悬浮）</button>
          </span>
        </span>
        <!-- 手动记一点:示教中才可用;禁用态 title 说明原因(新手引导) -->
        <button class="btn" :disabled="!teach.teaching.value || busy"
                :title="teach.teaching.value ? '把当前臂位置记录为一个示教点(加入运动表)' : '先进入示教后才能记点'"
                @click="teach.captureManualPoint()">手动记一点</button>
      </div>
      <!-- 控制配置:臂 + 采样状态(2026-09-06 收敛:拖动方式下拉已删,进人手拖动时在子菜单选) -->
      <div class="ctl-row mode-row">
        <label class="cfg grow">
          <span class="cfg-label">臂</span>
          <select v-model="teach.side.value" :disabled="teach.teaching.value">
            <option value="arm_L">左臂</option>
            <option value="arm_R">右臂</option>
          </select>
        </label>
        <!-- 采样状态徽标:绿色脉冲=采样中,灰色=未采样 -->
        <span class="sample" :class="{ on: teach.sampling.value }">
          {{ teach.sampling.value ? '● 采样中' : '○ 未采样' }}
        </span>
      </div>
      <!-- 文件操作:YAML 保存/加载、CSV 导出、动作库导出(低频,收窄为次级按钮) -->
      <div class="ctl-row file-row">
        <button class="btn ghost" :disabled="busy" @click="teach.saveTeach()">保存 YAML</button>
        <button class="btn ghost" :disabled="busy" @click="teach.loadTeach()">加载 YAML</button>
        <button class="btn ghost" :disabled="busy" @click="teach.exportCsv()">导出 CSV</button>
        <button class="btn ghost" :disabled="busy || !teach.rows.value.length" @click="teach.exportActionLibrary()">导出动作库</button>
      </div>
    </div>
    <!-- 状态消息：操作结果反馈（如"已退出示教（键盘踩点）"） -->
    <p class="message">{{ teach.message.value }}</p>
    <!-- 使用说明(2026-09-06 TEACH-MODE-CONVERGE 收敛为三节,验收 4):
         ① 键盘踩点(默认)——主按钮一键进入,不发拖动态,无需末端按钮;
         ② 人手拖动——子菜单选拖动空间,SDK 拖动就绪态,必须按住末端按钮 m_TipDI==1;
         ③ 退出——面板「退出示教」或 Esc(两模式同)。 -->
    <div class="tips">
      <span class="tt">键盘踩点（默认 · 进入示教）</span>
      <span><b>W/S</b> 前后 · <b>A/D</b> 左右 · <b>R/F</b> 升降 · <b>Q/E</b> 偏航 · <b>Z/X</b> 俯仰 —— <b>按住持续移动,松开即停</b></span>
      <span><b>1/2/3</b> 切步长：精调 2mm/0.5° → 常规 10mm/2° → 大步 30mm/5°（HUD 实时显示当前档位）</span>
      <span>走<b>位置模式指令流</b>,无需末端按钮、无拖动态（臂保持位置刚度）</span>
      <span class="tt">人手拖动（▾ 子菜单选择）</span>
      <span>关节拖动 / XYZ 平移 / RPY 旋转 / 协作释放(零力悬浮)——3D 腕端出现<b>琥珀拖动环</b></span>
      <span><b>必须按住末端按钮才真正拖动、松开即停</b>（m_TipDI==1;协作释放=重力补偿悬浮,拖到哪停到哪）</span>
      <span class="tt">退出</span>
      <span>本面板「退出示教」或 Esc（两种模式均回位置模式）</span>
    </div>
  </section>
</template>

<style scoped>
/* 2026-09-06 TEACH-MODE-CONVERGE:主按钮行两任务模式 + 人手拖动子菜单样式 */
.ctl-row { display:flex; gap:6px; margin-bottom:8px; align-items:center; }
.mode-row select { flex:1; min-width:0; font-size:11px; padding:6px 7px; }
/* 控制配置行:label+select 组合 */
.cfg { display:flex; align-items:center; gap:5px; min-width:0; }
.cfg.grow { flex:1; }
.cfg-label { flex-shrink:0; font-size:10px; color:var(--dim); letter-spacing:1px; }
/* 修复暗色主题下 option 半透明发虚(2026-09-06 用户截图反馈):
   原生 option 继承了页面的低透明度文字色,在不支持 option 样式的浏览器上几乎看不清;
   显式给 option 深色底+不透明字色,Windows/Chrome 下恢复清晰可读 */
select option {
  background:#0a1424; color:#d8ecff; opacity:1;
}
.sample { flex-shrink:0; font-family:var(--m); font-size:10px; padding:4px 9px;
  border-radius:999px; border:1px solid rgba(89,128,157,.35); color:var(--dim);
  background:rgba(3,10,22,.5); transition:.2s; }
.sample.on { color:var(--grn); border-color:rgba(52,211,153,.55);
  background:rgba(52,211,153,.09); box-shadow:0 0 10px rgba(52,211,153,.25);
  animation:sample-pulse 1.4s ease-in-out infinite; }
@keyframes sample-pulse {
  0%,100% { box-shadow:0 0 6px rgba(52,211,153,.18); }
  50%     { box-shadow:0 0 16px rgba(52,211,153,.42); }
}
.main-row .btn { flex:1; font-size:11px; padding:8px 6px; font-weight:600; letter-spacing:1px; }
.file-row .btn { flex:1; font-size:10px; padding:6px 4px; }
.btn.ghost { border-color:rgba(46,230,214,.16); background:rgba(46,230,214,.03);
  color:var(--dim); }
.btn.ghost:hover { background:rgba(46,230,214,.1); color:var(--acc); }
/* 人手拖动子菜单(2026-09-06):包裹层 relative 锚定绝对定位菜单 */
.dragmenu-wrap { position:relative; flex:1; display:flex; min-width:0; min-width:200px; }
.dragmenu-wrap .btn { width:100%; }
.dragmenu { position:absolute; top:calc(100% + 6px); left:0; right:0; z-index:30; min-width:260px; max-width:340px;
  display:flex; flex-direction:column; gap:2px; padding:4px;
  border:1px solid rgba(46,230,214,.35); border-radius:8px;
  background:#081524; box-shadow:0 10px 30px rgba(0,0,0,.55);
  animation:dm-in .14s ease-out; }
@keyframes dm-in { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
.dm-item { text-align:left; font-size:11px; padding:8px 10px; border-radius:6px;
  border:1px solid transparent; background:transparent; color:rgba(216,236,255,.92);
  cursor:pointer; white-space:normal; overflow:visible; line-height:1.35; }
.dm-item:hover { background:rgba(46,230,214,.12); color:#eaffff;
  border-color:rgba(46,230,214,.3); }
.dm-item:disabled { opacity:.45; cursor:not-allowed; }
/* tips 分节样式(2026-09-06):小节标题高亮 + 键位说明主体 */
.tips { margin-top:8px; padding:7px 9px; border:1px dashed rgba(251,191,36,.32); border-radius:7px;
  background:rgba(251,191,36,.06); font-size:11px; color:rgba(216,236,255,.78); line-height:1.6; }
.tips span { display:block; }
.tips b { color:#fbbf24; }
.tips .tt { margin-top:4px; font-size:10px; letter-spacing:2px; color:#fbbf24; }
.tips .tt:first-child { margin-top:0; }
</style>
