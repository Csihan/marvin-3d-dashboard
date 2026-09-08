/**
 * @file    vite.config.ts
 * @brief   Vite 构建配置：当前为 Vue 插件默认基线，未叠加自定义构建参数
 * @author Csihan
 * @date    2026-08-30（注释审查补齐）
 */
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
})
