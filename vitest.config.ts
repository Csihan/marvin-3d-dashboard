/**
 * @file    vitest.config.ts
 * @brief   Vitest 测试配置：与 Vite 同配置（Vue 插件），面向 utils/composables 纯函数单测
 * @author Csihan
 * @date    2026-09-01
 */
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    // 纯函数单测不依赖 DOM；如后续测组件再补 environment: 'jsdom' 与依赖
    environment: 'node',
  },
})
