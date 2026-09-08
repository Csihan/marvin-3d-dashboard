<script setup lang="ts">
/**
 * @file    PanelGuide.vue
 * @brief   高级面板通用「参数说明」折叠块——每个高级页签的参数设置指南统一入口
 * @author Csihan
 * @date    2026-09-04
 *
 * 背景（2026-09-04 用户反馈）：高级面板中各模式的参数缺乏设置说明，
 * 操作者不知道每个字段"是什么、填多少、为什么"。本组件提供统一的
 * 折叠式说明块：标题可点击展开/收起，内容区约定三种排版元素——
 *   - <p class="g-p">       普通说明段落
 *   - <div class="g-row">   参数条目（b=参数名，span=含义与建议值）
 *   - <ol class="g-steps">  有序操作步骤
 *   - <p class="g-warn">    危险/注意事项（琥珀色）
 * 各面板只写内容、不管样式，保证 9 个页签说明观感一致。
 */
import { ref } from 'vue'

defineProps<{ /** 说明块标题，如「阻抗控制」 */ title: string }>()

/** 展开/收起状态：默认展开（用户要求说明要"全面"可见，宁多勿藏） */
const open = ref(true)
</script>

<template>
  <div class="panel-guide">
    <!-- 折叠头：点击切换说明区显隐 -->
    <button class="g-head" @click="open = !open">
      <i>{{ open ? '▾' : '▸' }}</i>参数说明 · {{ title }}
    </button>
    <!-- 说明主体：v-show 保留 DOM,切换无重排开销 -->
    <div v-show="open" class="g-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
/* 外壳：与面板内容区分隔的浅底卡片,视觉上"说明书"定位,不抢操作区 */
.panel-guide { margin-top:10px; border:1px dashed rgba(46,230,214,.2);
  border-radius:8px; background:rgba(46,230,214,.03); overflow:hidden; }
.g-head { display:flex; align-items:center; gap:6px; width:100%; border:none;
  background:rgba(46,230,214,.06); color:var(--acc); cursor:pointer;
  font-family:var(--f); font-size:10px; font-weight:600; letter-spacing:1.5px;
  padding:6px 10px; text-align:left; transition:.15s; }
.g-head:hover { background:rgba(46,230,214,.12); }
.g-head i { font-style:normal; font-size:9px; color:var(--acc); width:10px; }
.g-body { padding:8px 10px 10px; }
/* 普通说明段 */
.g-p { margin:0 0 6px; font-size:10px; color:rgba(216,236,255,.72); line-height:1.6; }
/* 参数条目:参数名等宽高亮 + 含义说明,与 HelpGuide 的 .row 同风格 */
.g-row { display:flex; align-items:baseline; gap:8px; padding:3px 0;
  border-bottom:1px dashed rgba(46,230,214,.08); }
.g-row:last-of-type { border-bottom:none; }
.g-row b { flex:none; width:76px; font-family:var(--m); font-size:9.5px; color:#fff; }
.g-row span { font-size:9.5px; color:var(--dim); line-height:1.5; }
/* 有序操作步骤 */
.g-steps { margin:4px 0 6px; padding-left:18px; }
.g-steps li { font-size:10px; color:rgba(216,236,255,.72); line-height:1.7; }
.g-steps li::marker { color:var(--acc); font-family:var(--m); }
/* 危险/注意条 */
.g-warn { margin:6px 0 0; font-size:9.5px; color:rgba(251,191,36,.85);
  line-height:1.55; padding:5px 8px; border-radius:5px;
  background:rgba(251,191,36,.06); border:1px solid rgba(251,191,36,.16); }
</style>
