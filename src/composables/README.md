# Composables 文档

> Vue 3 Composition API 可复用逻辑单元。
> 每个 composable 封装一个独立的功能域，通过依赖注入避免循环引用。

## 清单

### `useRos.ts` — rosbridge WebSocket 连接管理

**职责**：rosbridge 连接/断开/自动重连/数据流看门狗/出站金丝雀

**导出**：
- `connected: Ref<boolean>` — 连接状态（true=已连接，false=断开）
- `subscribe(topic, type, cb)` — 话题订阅（返回 Topic 对象用于 unsubscribe）
- `callService(name, type, args)` — 服务调用（4s 超时自动重连）
- `publish(topic, type, payload)` — 话题发布（fire-and-forget）

**关键机制**：
- **自动重连**：断开后指数退避重连（2s → 3s → 4.5s → ... → 10s 上限）
- **数据流看门狗**：12s 无入站数据 → 主动断开交由重连逻辑自愈
- **出站金丝雀**：每 6s 调用 `/rosapi/get_time` 探测出站通道，2.5s 超时即重连

---

### `useRobotStatus.ts` — 统一状态订阅与解析

**职责**：`/robot/status` 消息解析 → `robotStore` 响应式更新 → 四边面板消费

**导出**：
- `robotStore: reactive<RobotStatusStore>` — 全局单例 store（多面板共享）
- `parseStatusMessage(d, store)` — 纯函数：一条消息 + store → 就地更新
- `startStatusSubscription(subscribe)` — 建立 rosbridge 订阅（App 挂载时调用一次）

**消息格式**：
```json
{
  "type": "status_report",
  "source": "...",
  "module": "arm_L | arm_R | gripper_L | gripper_R | head_yaw | head_pitch | wheel_1..4 | steer_1..4 | lift_motor | bend_motor",
  "data": { ... }
}
```

---

### `useRobot3D.ts` — 3D 场景与交互

**职责**：URDF 模型加载 + 关节驱动 + 拖动控制 + 粒子背景 + Bloom 后处理 + Raycaster 点击

**导出**（供 App.vue 使用）：
- `updateJoints(msg)` — `/joint_states` → URDF 关节值驱动
- `selectedPart: Ref<SelectedPart | null>` — 3D 点击选中部位
- `focusMode: Ref<boolean>` — 聚焦模式（选中部位后其余 HUD 淡出）
- `modelLoaded: Ref<boolean>` — URDF 模型是否加载完成
- `resetView()` — 相机复位到初始视角
- `jointPositions: Ref<Record<string, number>>` — 全局关节预览值（rad）
- `jointLimits: Ref<Record<string, {min, max}>>` — URDF 限位
- `jointPending: Ref<Record<string, {target, timedOut}>>` — 关节 pending 状态
- `projectPartToScreen(partId)` — 部位世界坐标 → 屏幕投影
- `previewJointTarget(name, rad)` — 关节即时预览（registerPending 抑制回弹）
- `driveGripper(side, positionM)` — 夹爪开度驱动（URDF prismatic）
- `previewChassis / followChassis` — 底盘升降/弯腰预览与反馈跟随
- `previewHead / followHead` — 头部摇头/点头预览与反馈跟随
- `clearKbSelection()` — 清除键盘微调选中
- `computeTool0(side)` — FK 正解（tool0 世界位姿）
- `solveTool0IK6D(side, pos, quat, angles)` — 6D IK 反解

---

### `useTeach.ts` — 示教控制器

**职责**：拖动模式切换 + 10Hz 采样 + 运动表管理 + 回放 + S 动作 + 文件服务

**导出**：
- `side: Ref<TeachSide>` — 当前示教臂（'arm_L' | 'arm_R'）
- `teaching / sampling` — 状态标志
- `rows: Ref<TeachPoint[]>` — 运动表示教点数组
- `selectedIndex` — 当前选中行
- `enterTeach() / exitTeach()` — 进入/退出示教
- `captureManualPoint()` — 手动补点
- `saveTeach() / loadTeach()` — YAML 保存/加载
- `exportCsv()` — CSV 导出
- `replayStep(index)` — 关节角直发回放
- `replayCartesian(index)` — 笛卡尔 IK 回放（P-B 路线）
- `triggerDemo(actionId)` — S 动作执行
- `loadPresets() / savePreset()` — 夹爪预设管理
- `exportActionLibrary()` — 动作库 JSON 导出
