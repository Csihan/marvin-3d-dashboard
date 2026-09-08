/**
 * @file    main.ts
 * @brief   应用入口：创建 Vue 实例、注册 DataV 组件库、挂载根组件
 * @author Csihan
 * @date    2026-08-28
 * 头部注释是项目的标准元信息，明确这个文件的作用、作者和归属，是企业级项目的规范写法
 */
// 从vue官方包中导入createApp方法，这是Vue3专属的应用创建API，替代了Vue2里new Vue()的写法
import { createApp } from 'vue'

// 导入项目的根组件App.vue，这个组件是整个大屏项目的根容器，所有页面、子组件都会嵌套在它里面渲染
import App from './App.vue'

// 导入全局自定义样式文件，这里可以配置大屏的全局背景色、自定义通用字体、边距重置、全局动画等基础样式
import './style.css'

// 导入@kjgl77/datav-vue3这个专门面向可视化大屏开发的第三方组件库，里面封装了很多现成的数字翻牌、边框、飞线、图表装饰等开箱即用的DataV专用组件
import DataV from '@kjgl77/datav-vue3'

// 2026-09-03：运行配置加载器——dashboard.yaml 是现场可调参数（rosbridge/文件服务/门禁）的唯一来源
import { loadDashboardConfig } from './config/dashboardConfig'

/**
 * 应用启动引导（2026-09-03 重构为异步 bootstrap）：
 * 1. 挂载前先加载运行配置 dashboard.yaml（public/ 下，构建后随 dist 部署，改完 F5 生效）；
 * 2. 加载失败/文件缺失时 loadDashboardConfig 内部回退内置默认值并告警——绝不阻断大屏启动；
 * 3. 配置就绪后再创建并挂载应用，保证 useRos/useTeach/App 读到的都是真实配置
 *    （静态 import 的模块顶层代码会先于 main.ts 执行，因此消费方必须在函数调用时取配置）。
 */
async function bootstrap(): Promise<void> {
  await loadDashboardConfig()

  // 调用createApp方法，传入根组件App，生成一个独立的Vue应用实例，这个实例是当前整个大屏应用的唯一核心对象
  const app = createApp(App)

  // 调用Vue实例的use()方法全局注册DataV组件库，注册之后，你在项目的任何页面、任何组件里，都可以直接使用DataV库提供的所有可视化组件，不需要重复单个导入
  app.use(DataV)

  // 将Vue应用实例挂载到HTML页面里id为app的DOM节点上，完成整个应用的渲染启动，正式把你写的Vue大屏代码渲染到浏览器的页面里
  app.mount('#app')
}

// void 前缀：明确"有意不等待"这个异步流程，启动失败已由 loadDashboardConfig 内部兜底
void bootstrap()
