<script setup lang="ts">
/**
 * @file    HelpGuide.vue
 * @brief   操作指南（全屏浮层）：界面总览 / 相机浏览 / 朝向口径 / 关节球微调 / 拖动 IK / 底部坞 / 退出安全
 * @author Csihan
 * @date    2026-08-29（2026-09-04 全面扩充）
 *
 * 2026-08-29 新增：用户反馈"需要有详细使用说明"。右上角 ? 帮助打开本指南，
 * 汇总三类控制方式（浏览视角 / 关节微调 / 协作释放 RELEASE）的键鼠组合与退出/safety 出口。
 * 2026-09-04 扩充（用户口径"web 相关说明性文字补充全一点"）：
 *   - 新增「界面总览」：四大区域(左右侧栏/3D 视口/底部坞/角落 HUD)职责说明;
 *   - 新增「朝向与左右口径」：正面=X+、相机机位、画面左右与机器人左右关系
 *     （与本仓库 orientation.ts 的朝向口径一致，消除"屏幕上哪边是机器人左边"的常见困惑）;
 *   - 新增「底部坞：动作/示教/高级/视图」：入口级说明;
 *   - 移除右上角「◉ 全景」引用（该按钮已删,视图复位统一走底部 dock）;
 *   - 高级面板各参数的逐项说明在各页签内联（PanelGuide 组件）,本指南不重复。
 * 2026-09-05（手册审查 A1/A2）：第五章标题/正文统一「协作释放(RELEASE)」（手册 §2.6
 * state=4），补"按住末端按钮才真正拖动、松开即停"执行前提（§5.6/§12.6 m_TipDI==1）。
 */
defineEmits<{ close: [] }>()
</script>

<template>
  <div class="help-mask" @click.self="$emit('close')">
    <div class="help-card">
      <header>
        <h2>操作指南 · 双臂人形轮式机器人</h2>
        <button class="close" @click="$emit('close')">✕</button>
      </header>

      <div class="scroll">
        <section>
          <h3>〇、界面总览</h3>
          <p class="lead">大屏分四个功能区：<b>3D 视口</b>（中央主视野，机器人模型 + 关节球/拖动环交互）、<b>左右侧栏</b>（左：臂/爪/头部/底盘控制面板；右：状态监控与关节检查器）、<b>底部坞</b>（动作/示教/高级/视图 + E-STOP）、<b>角落 HUD</b>（右上模式徽标与帮助、右下 ROS 状态与急停台）。所有面板交互只在 3D 视口未聚焦时可用；点击 3D 部位会进入聚焦模式，两侧面板变暗让位，Esc 退出聚焦。</p>
        </section>

        <section>
          <h3>一、朝向与左右口径（重要）</h3>
          <p class="lead">打开页面看到的即机器人<b>正面</b>（头部摄像头/躯干面板朝向屏幕）。坐标系约定：机器人正面 = X+、自身左侧 = Y+、竖直向上 = Z+；相机固定停在正面 X+ 侧回望机器人。</p>
          <div class="row"><b>画面左 / 画面右</b><span>正面视角下：<b>画面左 = 机器人左臂</b>、画面右 = 机器人右臂（面对面看对方：对方的左手在你左边，左右不互换，实测投影已核对）</span></div>
          <div class="row"><b>front / rear 轮</b><span>模型数据中 front 组为机器人前轮；渲染朝向已按装配口径对齐（见 orientation.ts）</span></div>
          <div class="row"><b>双击手柄前伸</b><span>沿机器人正面方向（+X）前伸到胸前工作位</span></div>
        </section>

        <section>
          <h3>二、浏览视角（鼠标）</h3>
          <div class="row"><b>左键按住拖拽</b><span>旋转相机，360° 观察机器人</span></div>
          <div class="row"><b>滚轮</b><span>拉近 / 推远（相机缩放）</span></div>
          <div class="row"><b>右键拖拽</b><span>平移场景</span></div>
          <div class="row"><b>双击空白处</b><span>复位到全景视角</span></div>
          <div class="row"><b>底部坞「视图」</b><span>一键复位视角（回到打开页面的正面机位）</span></div>
        </section>

        <section>
          <h3>三、关节球微调（修饰键 + 鼠标 + 键盘）</h3>
          <p class="lead">关节球默认隐藏、保持画面干净——<b>双击某臂</b>显示该臂 7 个关节球，<b>双击单个关节球</b>只保留该球并聚焦。球操作必须配合修饰键：<b>纯左键只旋转相机</b>，碰到球也不会误动作、松开不会残留控制。</p>
          <div class="row"><b>双击机械臂</b><span>显示该臂全部 7 个关节球（再双击空白/全景即隐藏）</span></div>
          <div class="row"><b>双击关节球</b><span>只保留该关节球并聚焦拉近 → 打开关节面板</span></div>
          <div class="row"><b>纯左键</b><span>只旋转视角——即使按在关节球上也不操作关节</span></div>
          <div class="row"><b>Shift/Alt + 点击关节球</b><span>选中 → 顶部出现键盘提示条 + 右侧关节面板</span></div>
          <div class="row"><b>Shift/Alt + 按住拖球</b><span>单轴调角（1px ≈ 0.05°）</span></div>
          <div class="row"><b>Shift + 拖</b><span>链动：J<em>n</em>~J7 后续关节一起动</span></div>
          <div class="row"><b>Alt + 拖</b><span>精细档 0.005°/px（微调）</span></div>
        </section>

        <section>
          <h3>四、键盘微调（选中关节后有效）</h3>
          <div class="row"><b>W / S</b><span>当前关节 +/−0.5°</span></div>
          <div class="row"><b>Shift + W / S</b><span>大步 +/−3°（快速摆位）</span></div>
          <div class="row"><b>Ctrl + W / S</b><span>精细 +/−0.05°</span></div>
          <div class="row"><b>Tab / D / A</b><span>切换到 下一 / 上一 关节</span></div>
          <div class="row"><b>Q / E</b><span>同臂肩关节(J2) 抬 / 降</span></div>
          <div class="row"><b>Space</b><span>该臂回 HOME 位</span></div>
          <div class="row"><b>Esc</b><span>取消选中 / 关闭面板</span></div>
        </section>

        <section>
          <h3>五、示教模式（键盘踩点 + 人手拖拽）</h3>
          <p class="lead">示教面板有两个任务模式（2026-09-06 收敛）：<b>「进入示教」= 键盘踩点</b>（默认，一键进入零选择）：走位置模式指令流、<b>无琥珀环、无需末端按钮</b>，键盘即主手段；<b>「人手拖动 ▾」</b>（关节/XYZ/RPY/协作释放）：进拖动就绪态，该臂<b>腕端出现琥珀拖动环</b>，<b>必须按住末端按钮</b>（手册 §5.6/§12.6 m_TipDI==1）松开即停。两种模式键盘 Jog 键位相同。</p>
          <div class="row"><b>W / S / A / D</b><span>键盘 Jog 末端平移：前后 / 左右（相机视线 + 世界系，按住持续、松开即停）</span></div>
          <div class="row"><b>R / F</b><span>键盘 Jog 末端升降</span></div>
          <div class="row"><b>Q / E · Z / X</b><span>键盘 Jog 姿态：偏航 / 俯仰</span></div>
          <div class="row"><b>1 / 2 / 3</b><span>切步长档：精调 2mm/0.5° · 常规 10mm/2° · 大步 30mm/5°（HUD 显示当前档）</span></div>
          <div class="row"><b>纯左键 拖环</b><span>人手拖拽（选人手拖动模式后）：腕端位置跟随（整臂 7 关节 IK）；需按住末端按钮</span></div>
          <div class="row"><b>Shift + 左键 拖环</b><span>空间角度：TCP 位置锁定，只旋转末端姿态（6D IK 解算）</span></div>
          <div class="row"><b>Alt + 左键 拖环</b><span>多动角度：J2~J7 链动微调（真机限位收敛，无跳变）</span></div>
          <div class="row"><b>Shift + W/S/A/D 或 ↑↓←→</b><span>键盘步进 TCP（备用）：相机平面内每次 2mm 慢步进</span></div>
          <div class="row"><b>拖住手柄 + 滚轮</b><span>沿视线 拉近/推远 深度（解决"手柄在身后"）</span></div>
          <div class="row"><b>双击手柄</b><span>一键前伸到胸前工作位（肩前 32cm）</span></div>
          <div class="row"><b>Shift/Alt + 拖 升降/弯腰球</b><span>升降（绿球垂直拖=推拉高度）/ 弯腰（紫球）——同样不允许裸左键，纯左键只转视角</span></div>
          <div class="row"><b>拖动进行中</b><span>屏幕顶部琥珀提示条常驻显示，可直接看到状态</span></div>
        </section>

        <section>
          <h3>六、底部坞：动作 / 示教 / 高级 / 视图</h3>
          <p class="lead">屏幕底部呼吸胶囊坞是所有工作流的入口，悬停坞体增亮、点击展开对应弹窗：</p>
          <div class="row"><b>动作</b><span>S00~S14 共 15 个预定义演示动作，点击即触发，状态条实时反馈执行中/成功/失败</span></div>
          <div class="row"><b>示教</b><span>示教操作区（2026-09-06 收敛）：「进入示教」=键盘踩点一键进入 / 「人手拖动 ▾」=选关节/XYZ/RPY/协作释放后确认进入 → 手动记点 → 保存 YAML/导出 CSV/动作库；下方运动表管理已记录点</span></div>
          <div class="row"><b>高级</b><span>9 个 SDK 高级页签（阻抗/力控/PVT/参数/规划/协同/运动学/末端/系统），每个页签底部有可折叠的「参数说明」逐项讲清字段含义与建议值</span></div>
          <div class="row"><b>视图</b><span>一键复位 3D 相机（与双击空白等效）</span></div>
          <div class="row"><b>E-STOP / RESET</b><span>急停与恢复（见下方"退出与安全"）</span></div>
        </section>

        <section>
          <h3>七、退出与安全</h3>
          <div class="row"><b>Esc</b><span>一键退出协作释放模式（回到位置模式）</span></div>
          <div class="row"><b>拖动提示条「退出拖动」</b><span>鼠标退出入口（等价 Esc）</span></div>
          <div class="row"><b>F12</b><span>全局软急停（危险时随时拍停，所有运动立即停止）</span></div>
          <div class="row"><b>右下角 E-STOP</b><span>全局急停；锁定后变绿色「RESET 恢复」一键复位</span></div>
          <div class="row"><b>示教退出</b><span>示教弹窗内「退出示教」按钮或直接按 Esc</span></div>
        </section>
      </div>

      <footer>按 Esc 或点击遮罩关闭本指南</footer>
    </div>
  </div>
</template>

<style scoped>
.help-mask { position:fixed; inset:0; z-index:60; display:flex; align-items:center; justify-content:center;
  background:rgba(1,4,10,.62); backdrop-filter:blur(4px); }
/* 2026-09-04 扩充:卡体加宽加高,容纳新增的界面总览/朝向/底部坞章节 */
.help-card { width:min(700px, 94vw); max-height:88vh; display:flex; flex-direction:column;
  border-radius:14px; border:1px solid rgba(46,230,214,.28); background:linear-gradient(160deg,#06121f,#020a14);
  box-shadow:0 18px 60px rgba(0,0,0,.6), 0 0 40px rgba(46,230,214,.08); }
header { display:flex; align-items:center; justify-content:space-between; padding:14px 18px 10px;
  border-bottom:1px solid rgba(46,230,214,.12); }
header h2 { margin:0; font-family:var(--d); font-size:14px; letter-spacing:3px; color:#eaffff;
  text-shadow:0 0 12px rgba(46,230,214,.35); }
.close { border:none; background:rgba(46,230,214,.1); color:var(--acc); font-size:14px; width:28px; height:28px;
  border-radius:8px; cursor:pointer; }
.close:hover { background:rgba(46,230,214,.25); color:#fff; }
.scroll { overflow-y:auto; padding:8px 18px 16px; }
section { margin-top:12px; }
h3 { margin:0 0 6px; font-family:var(--d); font-size:11px; color:var(--acc); letter-spacing:2px; }
.lead { margin:0 0 6px; font-size:11px; color:rgba(216,236,255,.75); line-height:1.55; }
.row { display:flex; align-items:baseline; gap:10px; padding:5px 0; border-bottom:1px dashed rgba(46,230,214,.09); }
.row b { width:168px; flex:none; font-family:var(--m); font-size:11px; color:#fff; }
.row span { font-size:12px; color:var(--dim); line-height:1.45; }
.row b em { font-style:normal; color:var(--acc); }
footer { padding:10px 18px 16px; text-align:center; font-size:10px; color:rgba(159,184,196,.5); font-family:var(--m); letter-spacing:2px; }
</style>