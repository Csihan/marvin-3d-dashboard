/**
 * @file    useRobot3D.ts
 * @brief   沉浸式全屏 3D 机器人场景：URDF 整机模型 + 粒子背景 + CSS2D 标签 + Raycaster 点击
 * @author Csihan
 * @date    2026-08-28
 *
 * 模型方案（开源模板版，2026-09-08）：
 *   - 改用 URDFLoader 加载内置开源示例 demo_robot.urdf（纯 primitive 几何，
 *     双臂 7-DOF + 4WS 底盘 + 升降躯干，关节命名见 public/models/urdf/ 文件头）；
 *   - packages 映射把 URDF 里的 package:// 路径解析到前端静态资源
 *     （这正是"URDF 上不了 Web"的常见根因：浏览器不认识 package:// 与 xacro）；
 *   - 关节驱动：URDF 关节名与 ROS 上报一致（Joint1~7_L/R、gripper_L/R_joint、
 *     head_yaw/pitch_joint、torso_lift_joint、4WS 轮关节），/joint_states 与
 *     /robot/status 数值经 setJointValues 直接驱动，revolute 传弧度 / prismatic 传米；
 *   - 接入真实机器人：替换 public/models/urdf/ 下模型并改下方 loader.load
 *     路径；用 package:// mesh 时在 PACKAGE_MAP 补包名→静态路径映射。
 */
import { ref, onUnmounted } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import URDFLoader from 'urdf-loader'
import { robotStore } from './useRobotStatus'
import { LIFT_MIN_MM, LIFT_MAX_MM, liftMmToUrdf, urdfToLiftMm } from '../utils/chassisUnits'
// P1 纯函数提取（2026-09-01）：线性求解/四元数/IK 数学核心下沉到 utils/robotMath，
// 由 scene/ik 复用（本文件 IK 已委托 scene/ik，不再直接引用，见下方 P3 注释）。
// P2 装饰性 3D 拆出（2026-09-01）：星点/光环/太阳系/星云 + 选择性 Bloom 后处理
// 全部下沉到 scene/background.ts，本文件只做装配与调用（动画/渲染/缩放/释放）。
import { createBackground, GLOW_LAYER, dotTex } from '../scene/background'
// P3 交互拆分（2026-09-01）：CSS2D 浮动标签系统下沉 scene/labels.ts（依赖注入
// robot+jointPositions+allLabels），本文件只持有控制器并调 attach/refresh。
import { createRobotLabels } from '../scene/labels'
import type { RobotLabels } from '../scene/labels'
// P3 交互拆分（2026-09-02）：三类控制球（关节/底盘/头部）创建+悬停+命中+显隐集合
// 下沉 scene/markers.ts；本文件创建控制器后解构同名引用，拖动状态机调用点零改动。
import { createMarkers } from '../scene/markers'
import type { MarkersController } from '../scene/markers'
// P3 拖动拆分（2026-09-02）：拖动状态机下沉 scene/drag.ts（依赖注入 + 共享 DragState）
import { setupDragHandling } from '../scene/drag'
import { MODEL_YAW } from '../scene/orientation'
import { shouldInvert } from '../scene/jointCalibration'
import { createPickController } from '../scene/pick'
import type { DragState, DragDeps } from '../scene/drag'
// P3 交互拆分（2026-09-01）：相机聚焦/复位下沉 scene/camera.ts（依赖注入
// camera/controls/focusMode/homeView + onResetScene/onReset 副作用钩子）。
import { createCameraController } from '../scene/camera'
import type { CameraController } from '../scene/camera'
// P3 交互拆分（2026-09-01）：场景 IK（位置/6D/正解/限位钳制）下沉 scene/ik.ts，
// 依赖注入 robot 场景图；数学核心复用 utils/robotMath（P1）。
// 注：用别名导入，本文件保留同名薄包装（原签名含闭包 robotGroup 查找，调用点不变）。
import {
  solveArmIK as ikSolveArmIK,
  solveArmIK6D as ikSolveArmIK6D,
  computeTool0 as ikComputeTool0,
  solveTool0IK6D as ikSolveTool0IK6D,
  clampJointValue as ikClampJointValue,
} from '../scene/ik'

export interface JointState { name: string[]; position: number[] }
export interface SelectedPart { id: string; label: string }
export interface JointDragCommand {
  arm: 1 | 2
  jointName: string
  jointAnglesRad: number[]
}
export interface Robot3DOptions {
  onJointCommand?: (command: JointDragCommand) => void
  onJointSelect?: (jointName: string) => void
  onPartSelect?: (partId: string) => void
  onReset?: () => void
  /** 键盘 Space 触发当前选中臂 HOME（App 侧调 /robot/internal/arm/home）。 */
  onHomeRequest?: (side: 'L' | 'R') => void
  /**
   * 底盘控制球拖动命令（2026-08-29）：lift=升降目标 mm（绝对高度 903.3~1453.3）、
   * bend=弯腰目标 deg（±90）。App 侧节流 120ms 后分别走 platform_control.z /
   * motor_control(motor_type=2)。
   */
  onChassisCommand?: (cmd: { axis: 'lift' | 'bend'; value: number }) => void
  /**
   * 头部控制球拖动命令（2026-08-30 用户第七轮#2）：yaw=摇头目标 deg（±90，
   * motor_control motor_type=1）、pitch=点头目标 deg（±90，motor_type=3）。
   * 3D 内部 120ms 节流，App 侧经 headYawTo/headPitchTo 下发。
   */
  onHeadCommand?: (cmd: { axis: 'yaw' | 'pitch'; value: number }) => void
  /** 键盘笛卡尔 Jog 状态上报（2026-09-05）：步长档位切换/激活态，App HUD 订阅。 */
  onJogStateChange?: (s: { stepLevel: number; active: boolean }) => void
  /** 示教激活判定（2026-09-06 TEACH-MODE-CONVERGE 解法 A）：App 把 teach.teaching
   *  以箭头函数注入（延迟读取，防与 useTeach 循环依赖）；drag.ts 的 jogEnabled
   *  用它识别「键盘踩点不发 state=4」模式的键盘 Jog 启用前提。 */
  isTeachActive?: () => boolean
}

/** 双臂 14 个可拖关节；序号即运动表和协议 joint_angles 的数组序号。 */
// 圆形光点贴图 dotTex 已下沉 scene/background.ts（P2），ParticleBurst 复用导出值。

// J1~J7 功能定义（7-DOF 工业臂构型惯例，接入你的机器人后按实际构型调整）：
// J1=肩部水平回转、J2=肩部抬臂（模型域 J2=90°=垂直向下 home、全零=水平展开，
// 双臂 HOME 姿态口径；勿用 SDK 域 180°）。
// J4~J7 腕部四轴语义按构型惯例标注，接入真机时请逐轴确认。
export const JOINT_FUNCTIONS = [
  '肩部回转', '肩部抬臂', '肘部屈伸', '小臂回转', '腕部俯仰', '腕部摆转', '末端法兰回转',
]

const ARM_JOINTS = ['Joint1', 'Joint2', 'Joint3', 'Joint4', 'Joint5', 'Joint6', 'Joint7'] as const
const ARM_SIDES = ['L', 'R'] as const
const DEG2RAD = Math.PI / 180

/**
 * 一次性关节到位粒子爆发。
 * @note 粒子只在本地渲染，60 帧或 0.5 秒后自动 dispose，避免高频示教造成 GPU 泄漏。
 */
class ParticleBurst {
  private points: THREE.Points
  private velocities: THREE.Vector3[] = []
  private elapsed = 0
  private readonly life = 0.5

  constructor(scene: THREE.Scene, origin: THREE.Vector3) {
    const count = 30
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const colorStops = [new THREE.Color(0x38bdf8), new THREE.Color(0xa855f7), new THREE.Color(0xffffff)]
    for (let i = 0; i < count; i++) {
      positions[i * 3] = origin.x
      positions[i * 3 + 1] = origin.y
      positions[i * 3 + 2] = origin.z
      const color = colorStops[Math.min(2, Math.floor(i / count * 3))]
      colors[i * 3] = color.r
      colors[i * 3 + 1] = color.g
      colors[i * 3 + 2] = color.b
      this.velocities.push(new THREE.Vector3(
        (Math.random() - 0.5) * 1.6,
        Math.random() * 1.2,
        (Math.random() - 0.5) * 1.6,
      ))
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.points = new THREE.Points(geometry, new THREE.PointsMaterial({
      size: 0.022, vertexColors: true, transparent: true, opacity: 1, map: dotTex,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    scene.add(this.points)
    // 爆发粒子属于宇宙氛围特效 → 登记 GLOW 层参与 Bloom；交互本体（拖动环/关节球）不在此层
    this.points.layers.enable(GLOW_LAYER)
  }

  /** @return true 表示生命周期结束，调用方可 dispose。 */
  update(dt: number): boolean {
    this.elapsed += dt
    const attr = this.points.geometry.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < this.velocities.length; i++) {
      attr.setX(i, attr.getX(i) + this.velocities[i].x * dt)
      attr.setY(i, attr.getY(i) + this.velocities[i].y * dt)
      attr.setZ(i, attr.getZ(i) + this.velocities[i].z * dt)
    }
    attr.needsUpdate = true
    const material = this.points.material as THREE.PointsMaterial
    material.opacity = Math.max(0, 1 - this.elapsed / this.life)
    return this.elapsed >= this.life
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.points)
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose()
  }
}

// 全局关节预览值（rad）：拖动/滑条/面板下发共用的本地即时态，
// JointInspector/ArmPanel 读它做实时读数（2026-08-30 导出，配合第六轮#3 修复）
export const jointPositions = ref<Record<string, number>>({})
export const jointLimits = ref<Record<string, { min: number; max: number }>>({})
/**
 * 关节 pending 状态（P0 状态机，供 Inspector/ArmPanel 显示）：
 * target=本地目标角(rad)；timedOut=true 表示 2s 内未等到 ROS 反馈匹配，
 * 已解除本地目标抑制、模型回到 ROS 反馈位——UI 据此显示"超时"告警。
 */
export const jointPending = ref<Record<string, { target: number; timedOut: boolean }>>({})
const selectedPart = ref<SelectedPart | null>(null)
const modelLoaded = ref(false)
const focusMode = ref(false)

// package:// 包名 → 前端静态路径映射。
// 内置示例 demo_robot.urdf 全部用 primitive 几何，无需任何映射；
// 接入带 package:// 的真实模型时在此登记包名（如 { my_pkg: '/models/urdf/meshes/my_pkg' }），
// mesh 文件放到 public/models/urdf/meshes/<包名>/ 下即可。工具脚本见 tools/export_web_urdf.sh。
const PACKAGE_MAP: Record<string, string> = {}


export function useRobot3D(
    container: HTMLElement,
    labelContainer: HTMLElement,
    options: Robot3DOptions = {}) {
  // ═══ Renderer ═══
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  // ACES Filmic tone mapping：UnrealBloom 官方链要求开启（由 OutputPass 统一应用），
  // 高亮处柔和滚降不发死白，整体偏电影感。注意：会轻微改变整体色调，
  // E2E 截图像素判定阈值（如琥珀环 R>105）如失效需重新标定。
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  container.appendChild(renderer.domElement)

  // ═══ CSS2D Renderer（3D 空间中的 HTML 标签）═══
  const css2dRenderer = new CSS2DRenderer()
  css2dRenderer.setSize(container.clientWidth, container.clientHeight)
  css2dRenderer.domElement.style.position = 'absolute'
  css2dRenderer.domElement.style.top = '0'
  css2dRenderer.domElement.style.pointerEvents = 'none'
  labelContainer.appendChild(css2dRenderer.domElement)

  // ═══ Scene / Camera ═══
  // 整机为真实尺度（米，base_footprint 在原点贴地），相机/目标按整机高度校准。
  // 背景改为 CSS 径向渐变（.vp3d），scene 保持 alpha 透明以透出深空底色；
  // FogExp2 让远处网格/粒子沉入夜色，形成参考图的纵深氛围。
  const scene = new THREE.Scene()
  scene.background = null
  scene.fog = new THREE.FogExp2(0x020610, 0.055)
  // ═══ 装饰背景（P2 2026-09-01 已下沉 scene/background.ts）═══
  // 星点/光环/太阳系/星云/Bloom 后处理的声明与创建全部移出本文件，
  // 由 createBackground 统一管理，下方在相机/灯光就绪后调用并持有控制器。
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envScene = new RoomEnvironment()
  scene.environment = pmrem.fromScene(envScene, 0.04).texture
  envScene.dispose?.()
  const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.05, 100)
  // 初始机位快照（drag.ts 的 DragDeps 仍需要此引用；朝向语义已改由
  // scene/orientation.ts 的 ROBOT_FRONT 承担，此处只做"正面 X+ 侧机位"）。
  const defaultCamPos = new THREE.Vector3()
  // 初始视角（用户口径）：相机在机器人前方 X+，往 X- 方向看，Z+ 方向稍微抬高。
  // homeView 快照保存此姿态，ESC/双击空白/dock「视图」都严格回到这里。
  camera.position.set(2.3, 1.55, 0.45)
  defaultCamPos.copy(camera.position)
  camera.lookAt(0, 0.85, 0)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.set(0, 0.85, 0)
  controls.enableDamping = true
  controls.dampingFactor = 0.06
  controls.minDistance = 0.3
  controls.maxDistance = 15

  // ═══ 灯光 ═══
  scene.add(new THREE.AmbientLight(0x556677, 1.2))
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.5)
  keyLight.position.set(3, 5, 4)
  scene.add(keyLight)
  const rimLight = new THREE.DirectionalLight(0x5599cc, 1.0)
  rimLight.position.set(-4, 2, -3)
  scene.add(rimLight)
  const fillLight = new THREE.PointLight(0xffffff, 1.0, 20)
  fillLight.position.set(0, 1, 3)
  scene.add(fillLight)

  // （平台青色点光已移除 2026-08-30：它是"模型脚下发光"的组成光源，按用户口径一并撤掉）


  // ═══ 装饰背景 + 选择性 Bloom 后处理（P2 已下沉 scene/background.ts）═══
  // 星点/光环/太阳系/星云/两级后处理全由 background 控制器管理；
  // 渲染调用 background.render(camera)、动画调用 background.update(t,dt,dim)。
  const background = createBackground(scene, camera, renderer, container)
  // P3：相机控制器（聚焦/复位）延迟到 homeView 快照就绪后构造（见下方创建点），
  // 此处先声明变量供 flyTo/resetToHome 薄封装引用（调用发生在用户交互时，已初始化）。
  let cameraController: CameraController | null = null

  // ═══ 机器人模型容器 + 加载失败兜底占位 ═══
  const robotGroup = new THREE.Group()       // URDF 模型容器
  // 模型摆放（2026-09-04 用户实测确认「视角对、模型摆放错」）：
  // URDF 网格真实正面朝 -X（头/双臂挂载/后置导轨三重证据,见 orientation.ts）,
  // 对容器施加 MODEL_YAW=π 的纯旋转把正面转到世界 +X,与相机 home 机位
  // （+X 侧）构成面对面视角。
  // ⚠ 仅纯旋转（det=+1）：旧实现的 scale.z=-1 镜像（det=-1）会把所有
  // 关节转向视觉反转——那才是"模型与真机对向关节反向"的元凶,本次
  // 不恢复;残余的个体装配差异由 INVERT_JOINTS 校准表逐关节吸收（已归零,
  // 待 dbg_hw_stagec.py 真机重标）。
  robotGroup.rotation.y = MODEL_YAW
  const placeholderGroup = new THREE.Group() // 加载失败兜底（成功后隐藏）
  scene.add(robotGroup)
  scene.add(placeholderGroup)
  // 材质提升（用户反馈质感差）：MeshPhysicalMaterial 清漆层模拟工业涂层，
  // 钛银蓝机身 + 单面渲染（FrontSide 杜绝穿透透明感）+ 受控环境反射。
  const matP = new THREE.MeshPhysicalMaterial({
    color: 0x9fb0c2, metalness: .55, roughness: .38,
    clearcoat: .55, clearcoatRoughness: .32,
    side: THREE.FrontSide, envMapIntensity: .65,
  })
  const torsoP = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.35, 0.2), matP)
  torsoP.position.set(-0.48, 1.1, 0)   // 真实整机躯干位置（torso_link 口径）
  placeholderGroup.add(torsoP)

  // ═══ URDF 整机加载 ═══
  /**
   * mesh 加载回调：URDF 内 package:// 路径 → 前端静态 STL 路径。
   * @note urdf-loader 的 MeshLoadFunc 签名为 (path, manager, material, done)，
   *       material 由 loader 内部管理，这里只需解析路径 + 读 STL + 回传 mesh。
   */
  const loadMeshCb = (path: string, _manager: any, _material: any,
      done: (mesh: THREE.Mesh | null, err?: Error) => void): void => {
    // package://pkg/rel/path → /models/urdf/meshes/pkg/rel/path（PACKAGE_MAP 逐前缀匹配）
    let url = path
    for (const [pkg, prefix] of Object.entries(PACKAGE_MAP)) {
      if (path.startsWith(`package://${pkg}/`)) {
        url = path.replace(`package://${pkg}/`, `${prefix}/`)
        break
      }
    }
    if (!url.startsWith('/')) url = '/models/urdf/' + url.replace(/^\.\//, '')
    const loader = new STLLoader()
    loader.load(url, geo => {
      // 材质分色：按 mesh 路径关键字区分部件（内置示例为 primitive 几何不走此回调，
      // 接入真实模型后自动生效；可按你的 mesh 命名调整关键字）。
      const lower = url.toLowerCase()
      let material = matP
      if (lower.includes('gripper')) material = new THREE.MeshPhysicalMaterial({ color: 0xd8601a, metalness: .3, roughness: .42, clearcoat: .4, clearcoatRoughness: .3, side: THREE.FrontSide, envMapIntensity: .55 })
      const mesh = new THREE.Mesh(geo, material.clone())
      done(mesh)
    }, undefined, () => {
      console.warn(`[useRobot3D] mesh 加载失败: ${url}`)
      done(null, new Error(`mesh not found: ${url}`))   // 允许机器人骨架仍可显示
    })
  }

  const loader = new URDFLoader()
  loader.packages = PACKAGE_MAP as any   // package:// 包名 → 路径（旧版 API 也吃这种写法）
  loader.loadMeshCb = loadMeshCb as any
  // 内置开源示例模型（接入真实机器人时改成你的 URDF 文件名）
  loader.load('/models/urdf/demo_robot.urdf', robot => {
    // userData.linkName 写到 link 级节点，Raycaster 命中后向上回溯定位部位
    robot.traverse(obj => {
      if (obj.type === 'URDFLink') obj.userData.linkName = obj.name
      if ((obj as any).isMesh) { obj.castShadow = true }
    })
    // URDF Z 轴朝上（ROS 惯例）→ Three.js Y 轴朝上（WebGL 惯例）：
    // 绕 X 轴旋转 -90°（URDF +Z → WebGL +Y）。仅做 Z-up→Y-up 轴系变换，
    // 不绕 Y 翻转（方案 B，2026-09-04）：URDF X+ 原生即正面，翻转反而把
    // X± 镜到反侧，造成 front 轮渲染在身后、与真机对向关节方向观感相反。
    robot.rotation.x = -Math.PI / 2
    robot.rotation.y = 0
    robot.rotation.z = 0
    robotGroup.add(robot)
    modelLoaded.value = true
    ARM_JOINTS.forEach(baseName => {
      ARM_SIDES.forEach(side => {
        const jointName = `${baseName}_${side}`
        const limits = robot.joints?.[jointName]?.limit
        if (limits && Number.isFinite(Number(limits.lower)) && Number.isFinite(Number(limits.upper))) {
          jointLimits.value[jointName] = { min: Number(limits.lower), max: Number(limits.upper) }
        } else {
          jointLimits.value[jointName] = { min: -170 * DEG2RAD, max: 170 * DEG2RAD }
        }
      })
    })
    placeholderGroup.visible = false    // 真模型就位后隐藏兜底占位
    // P3：CSS2D 标签系统下沉 scene/labels.ts，模型就绪后构造控制器并挂载
    robotLabels = createRobotLabels({ robot, jointPositions, allLabels })
    robotLabels.attach()
    // P3：标记系统下沉 scene/markers.ts——控制器与本地容器共享同一份数组/集合，
    // 创建/悬停/命中逻辑全部委托给 markersCtl，本文件保留容器与调用点（行为零变化）。
    markersCtl = createMarkers({
      robot, jointPositions, camera, mouse, renderer, allLabels, labelObjs,
      jointMarkers, jointHoverLabels,
      chassisMarkers, chassisHoverLabels,
      headMarkers, headHoverLabels,
      visibleJointMarkers, visibleHeadMarkers, visibleChassisMarkers,
    })
    markersCtl.createJointMarkers()
    markersCtl.createChassisMarkers()   // 底盘升降/弯腰控制球（2026-08-29）
    markersCtl.createHeadMarkers()      // 头部摇头/点头控制球（2026-08-30）
    setupJointDrag()   // P3：原 createJointMarkers 末尾调用，解耦后由加载回调统一触发拖动事件绑定
    // ── E2E 测试钩子（2026-08-30，自动化测试专用，生产无副作用）──
    // state(): 关键关节当前角快照；markerScreen(): 控制球屏幕坐标（配合合成指针
    // 事件拖球）；partScreen(): 部位屏幕坐标（配合点击弹面板）。
    const markerScreen = (kind: 'head' | 'chassis' | 'joint', axis: string) => {
      const arr = kind === 'head' ? headMarkers : kind === 'joint' ? jointMarkers : chassisMarkers
      const m = arr.find(x => (x.userData.jointName ?? x.userData.headAxis ?? x.userData.chassisAxis) === axis)
      if (!m) return null
      const rect = renderer.domElement.getBoundingClientRect()
      const p = m.getWorldPosition(new THREE.Vector3()).project(camera)
      return { x: (p.x * .5 + .5) * rect.width + rect.left, y: (-p.y * .5 + .5) * rect.height + rect.top }
    }
    ;(window as any).__marvin3d = {
      state: () => ({
        headYawDeg: (jointPositions.value['head_yaw_joint'] ?? 0) * 180 / Math.PI,
        headPitchDeg: (jointPositions.value['head_pitch_joint'] ?? 0) * 180 / Math.PI,
        bendDeg: (jointPositions.value['torso_pitch_joint'] ?? 0) * 180 / Math.PI,
        liftMm: urdfToLiftMm(jointPositions.value['torso_lift_joint'] ?? 0),
      }),
      markerScreen,
      partScreen: (partId: string) => projectPartToScreen(partId),
      // Bloom 调参钩子（2026-08-30 场景升级）：控制台可实时调
      // __marvin3d.bloom.strength / .radius / .threshold 看效果，定型后再固化到代码。
      // P2 后 bloomPass 由 background 控制器持有，经此透传（接口不变）。
      bloom: background.bloomPass,
      // E2E 扩展（2026-08-30 拖动链路验证）：诊断拖动手柄挂载状态与位姿——
      // parentIsTool0/inScene 用于发现「模型二次加载导致手柄成孤儿节点」一类问题；
      // screen 为手柄投影屏幕坐标（合成指针拖动用）；armAngles 为当前臂角(deg)快照。
      dragDebug: () => ARM_SIDES.map(side => {
        const h = dragState.dragHandles[side]
        const robot = robotGroup.children[0] as any
        const tool0 = robot?.getObjectByName?.(`tool0_${side}`)
        let o: THREE.Object3D | null = h ?? null, inScene = false
        while (o) { if (o === scene) { inScene = true; break } o = o.parent }
        const toScreen = (obj: THREE.Object3D | null) => {
          if (!obj) return null
          const p = obj.getWorldPosition(new THREE.Vector3()).project(camera)
          return { x: Math.round((p.x * .5 + .5) * innerWidth), y: Math.round((-p.y * .5 + .5) * innerHeight) }
        }
        return {
          side, exists: !!h, visible: h?.visible ?? null, inScene,
          parentIsTool0: !!(h && tool0 && h.parent === tool0),
          handleWorld: h ? h.getWorldPosition(new THREE.Vector3()).toArray().map((v: number) => +v.toFixed(3)) : null,
          tool0World: tool0 ? tool0.getWorldPosition(new THREE.Vector3()).toArray().map((v: number) => +v.toFixed(3)) : null,
          handleScreen: toScreen(h ?? null), tool0Screen: toScreen(tool0 ?? null),
        }
      }),
      armAngles: (side: 'L' | 'R') => currentArmAngles(side).map(a => +(a * 180 / Math.PI).toFixed(1)),
      robotCount: () => robotGroup.children.length,
    }
    createDragHandles()
  })

  // ═══ /joint_states → URDF 关节值驱动 ═══
  // URDF 关节名与 ROS 完全一致：setJointValues 只对存在的关节生效，多余 name 被忽略
  function updateJoints(msg: JointState): void {
    const vals: Record<string, number> = {}
    msg.name.forEach((n, i) => { vals[n] = msg.position[i] ?? 0 })
    // 拖动/Inspector 本地目标优先；若反馈直接覆盖模型，鼠标会出现来回摆动。
    for (const name of pendingJointTargets.keys()) delete vals[name]
    Object.assign(jointPositions.value, vals)
    const robot = robotGroup.children[0]
    // ★ 2026-09-03 模型侧方向校准：反馈角度需对模型取反（J1/J3 对向安装），
    //   jointPositions 保持原始反馈值（供命令侧使用），模型侧单独构建反转副本。
    if (robot) {
      const modelVals: Record<string, number> = {}
      for (const [n, v] of Object.entries(vals)) {
        const side = n.endsWith('_L') ? 'L' as const : n.endsWith('_R') ? 'R' as const : null
        const baseName = n.replace(/_[LR]$/, '')
        modelVals[n] = side && shouldInvert(side, baseName) ? -v : v
      }
      ;(robot as any).setJointValues(modelVals)
    }
    msg.name.forEach((name, i) => {
      if (isArmJoint(name)) {
        lastFeedbackRad.set(name, msg.position[i] ?? 0)
        checkJointSettled(name, msg.position[i] ?? 0)
      }
    })
    // P3：标签文字刷新下沉 scene/labels.ts（臂角/爪开度/轮/转向，每帧状态到达时更新）
    robotLabels?.refresh()
  }

  // ═══ 关节球拖动控制 ═══
  const jointMarkers: THREE.Mesh[] = []
  const jointHoverLabels: Record<string, CSS2DObject> = {}
  const activeBursts: ParticleBurst[] = []
  // P3：标记系统控制器（容器注入共享引用，逻辑全部下沉 scene/markers.ts）；
  // 模型加载后赋值（见加载回调），拖动状态机等经委托函数间接访问。
  let markersCtl: MarkersController | null = null
  // pending 注册表：本地目标优先于 ROS 反馈驱动模型（防拖动回弹）；
  // sentAt 用于 P0 超时判定（2s 未 settle 自动解除抑制）。
  const PENDING_TIMEOUT_MS = 2000
  const pendingJointTargets = new Map<string, { angle: number; matches: number; sentAt: number }>()
  // 各关节最新 ROS 反馈（rad）：自适应超时用（目标距离越远允许的收敛窗口越长）
  const lastFeedbackRad = new Map<string, number>()
  /** 统一 pending 注册入口：拖动与 Inspector 滑杆都走这里。 */
  function registerPending(jointName: string, angle: number): void {
    pendingJointTargets.set(jointName, { angle, matches: 0, sentAt: performance.now() })
    jointPending.value[jointName] = { target: angle, timedOut: false }
  }
  // P3：拖动共享状态容器——拖动状态机（scene/drag.ts）与反馈抑制/到位判定/M4 拖动模式 UI
  // 跨模块共享同一引用（原 activeDrag/kbSelected/draggingArm/lastDragEndAt/dragHandles/
  // dragModeActive 6 个散落声明收敛于此，语义不变）。
  const dragState: DragState = {
    activeDrag: null,
    kbSelected: null,
    draggingArm: null,
    lastDragEndAt: 0,
    dragHandles: {},
    dragModeActive: { L: false, R: false },
  }

  /** 清除键盘微调选中（App Esc/关面板/退出拖动时调用） */
  function clearKbSelection(): void { dragState.kbSelected = null }
// 拖动平滑（2026-08-29）：拖动中/松手缓冲期内挂起反馈收敛，防反馈回拽抖动

  function isArmJoint(name: string): boolean {
    return /^Joint[1-7]_[LR]$/.test(name)
  }

  /** 关节球挂到各关节 child link 原点，跟随 URDF FK 一起运动。 */
  // ═══ 底盘控制球（2026-08-29）：升降（绿）+ 弯腰（紫），独立于手臂关节球数组 ═══
  // 单独数组的原因：M4 半透明逻辑（updateDragModeUI）按 userData.jointName 遍历
  // jointMarkers，底盘球没有该字段，混入会 undefined.endsWith 崩溃。
  const chassisMarkers: THREE.Mesh[] = []
  const chassisHoverLabels: Partial<Record<'lift' | 'bend', CSS2DObject>> = {}

  /** 反馈抑制窗口（2026-08-30 统一）：拖动中 / 松手 400ms / M4 拖动 → 反馈不回写模型。
   *  统一 feedbackHeld() 判定（替代 chassisDrag/headDrag/ikState/dragState 四套并行窗口）。 */
  const FEEDBACK_HOLD_MS = 400
  /** 统一反馈抑制判定：拖动中 / 松手 400ms / M4 拖动 → 反馈不回写模型。
   *  dragState.activeDrag 为外层统一拖动会话（见 setupJointDrag 内赋值），函数体内延迟读取。 */
  function feedbackHeld(): boolean {
    // 2026-09-02（M4 反馈口径修正）：删除旧的"任一臂 M4 → 全局抑制"子句——
    // 手动拖真机时该臂反馈必须照常回写模型（见 checkJointSettled M4 分支），
    // 底盘/头部反馈更不应被拖臂连带冻结（此前手动拖左臂会冻结升降/弯腰跟随）。
    // M4 期间命令抖动抑制由 pending 注册/清除 + 拖动会话窗口承担。
    return dragState.activeDrag !== null || performance.now() - dragState.lastDragEndAt < FEEDBACK_HOLD_MS
  }
  /** 反馈跟随入口（App watch 调用）：底盘/头部拖动中或缓冲期内丢弃反馈，其余照常回驱 */
  function followChassis(axis: 'lift' | 'bend', value: number): void {
    if (feedbackHeld()) return
    previewChassis(axis, value)
  }
  function followHead(axis: 'yaw' | 'pitch', deg: number): void {
    if (feedbackHeld()) return
    previewHead(axis, deg)
  }

  /** 当前值读取：lift=绝对高度 mm（由 URDF 滑台行程反推）；bend=deg */
  function chassisCurrentValue(axis: 'lift' | 'bend'): number {
    // P3：当前值读取下沉 scene/markers.ts
    return markersCtl?.chassisCurrentValue(axis) ?? 0
  }

  /** 底盘球本地预览（App 反馈 watch 与拖动共用）：值域钳位后写 jointPositions 驱动 URDF */
  function previewChassis(axis: 'lift' | 'bend', value: number): void {
    const robot = robotGroup.children[0] as any
    if (axis === 'lift') {
      const mm = Math.min(Math.max(value, LIFT_MIN_MM), LIFT_MAX_MM)
      jointPositions.value['torso_lift_joint'] = liftMmToUrdf(mm)
      robot?.setJointValues({ torso_lift_joint: liftMmToUrdf(mm) })
    } else {
      const rad = THREE.MathUtils.clamp(value * Math.PI / 180, -1.5708, 1.5708)
      jointPositions.value['torso_pitch_joint'] = rad
      robot?.setJointValues({ torso_pitch_joint: rad })
    }
  }

  /**
   * 头部预览（2026-08-30 HeadPanel）：yaw/pitch deg → head_yaw_joint/head_pitch_joint
   * rad（URDF 限位 ±1.5708 双向钳位）。HeadPanel 下发后本地即时跟随；App 层另有
   * head.yaw/pitch 反馈 watch 调同一入口，ROS 反馈到位后自然收敛于真实值。
   */
  function previewHead(axis: 'yaw' | 'pitch', deg: number): void {
    const robot = robotGroup.children[0] as any
    const rad = THREE.MathUtils.clamp(deg * Math.PI / 180, -1.5708, 1.5708)
    const name = axis === 'yaw' ? 'head_yaw_joint' : 'head_pitch_joint'
    jointPositions.value[name] = rad
    robot?.setJointValues({ [name]: rad })
  }

  // ═══ 头部控制球（2026-08-30 用户第七轮#2）：摇头（橙）+ 点头（粉）═══
  // 交互与底盘球一致：Alt/Shift+左键拖动，纯左键=转相机；yaw 水平拖、pitch 垂直拖。
  // 独立数组原因同 chassisMarkers：避免污染 jointMarkers 的 M4 半透明遍历。
  const headMarkers: THREE.Mesh[] = []
  const headHoverLabels: Partial<Record<'yaw' | 'pitch', CSS2DObject>> = {}

  /** 头部当前角读取（deg）：由 URDF 关节 rad 反推 */
  function headCurrentValue(axis: 'yaw' | 'pitch'): number {
    // P3：当前值读取下沉 scene/markers.ts
    return markersCtl?.headCurrentValue(axis) ?? 0
  }

  /** 头部球悬停态（与底盘球 updateChassisHover 同法） */
  function updateHeadHover(): void {
    // P3：悬停逻辑下沉 scene/markers.ts（容器注入共享引用）
    markersCtl?.updateHeadHover()
  }

  function clampJointValue(jointName: string, value: number): number {
    // P3：限位钳制逻辑下沉 scene/ik.ts，本文件仅注入 robot 场景图（原签名不变）
    return ikClampJointValue(jointName, value, robotGroup.children[0] as any)
  }

  function currentArmAngles(side: 'L' | 'R'): number[] {
    return ARM_JOINTS.map(name => jointPositions.value[`${name}_${side}`] ?? 0)
  }

  /**
   * 垂直拖动 1px = 0.05°（2026-08-29 从 0.12 下调，用户反馈步进太大）；
   * Alt=精细 0.005°/px；Shift=同臂后续关节链联动。
   * 命令以 30Hz 节流走 topic 流（App 侧 streamDragCommand），跟手不刷爆 rosbridge。
   */
  function setupJointDrag(): void {
    // P3：拖动状态机下沉 scene/drag.ts——依赖注入（只读依赖 DragDeps）+ 共享 DragState。
    // 原 484 行实现已迁至 src/scene/drag.ts 的 setupDragHandling，本函数仅做装配转发，
    // 行为零变化（命中路由/三阶段会话/键盘微调/滚轮推拉/双击前伸/场景级防误触全在那边）。
    // Jog 状态上报：转发给 App（HUD 步长档位显示），无订阅者时静默。
    const onJogStateChange: DragDeps['onJogStateChange'] = options.onJogStateChange
    setupDragHandling({
      renderer, mouse, camera, controls, robotGroup, jointPositions, jointMarkers,
      defaultCamPos, options, eventCleanup,
      registerPending, clampJointValue, currentArmAngles, computeTool0,
      findHeadMarkerByPointer, findChassisMarkerByPointer, findJointMarkerByPointer,
      findDragHandleByPointer, headCurrentValue, chassisCurrentValue, clampChassisValue,
      previewChassis, previewHead, solveArmIK, solveTool0IK6D,
      onJogStateChange,   // 键盘 Jog 状态上报（App HUD）
      // 2026-09-06（TEACH-MODE-CONVERGE 解法 A）：示教激活判定透传给拖动状态机，
      // jogEnabled 以「M4 回显 || teaching」判定（键盘踩点模式无 M4 回显，必须注入）
      isTeachActive: options.isTeachActive,
      ARM_JOINTS, ARM_SIDES, DEG2RAD,
    }, dragState)
  }

  /** 反馈连续 3 帧 <0.5° 才认为到位；不同驱动周期下仍能过滤瞬时采样噪声。 */
  function checkJointSettled(jointName: string, measured: number): void {
    const pending = pendingJointTargets.get(jointName)
    if (!pending) return
    // 2026-09-02（M4 反馈口径修正，替代 2026-08-30"永不解除"）：M4 拖动反馈即权威——
    // 手动拖真机时该臂反馈持续变化，直接清 pending 让 updateJoints 用反馈驱动模型
    // （Web 界面跟随手动拖动）。此前反馈被 pending 屏蔽 → 手动拖真机 3D 不动。
    const jointArm = jointName.endsWith('_L') ? 'L' : 'R'
    const arm = jointArm === 'L' ? robotStore.armL : robotStore.armR
    if (arm.mode === 4) {
      pendingJointTargets.delete(jointName)
      delete jointPending.value[jointName]
      return
    }
    // 拖动平滑（2026-08-29）：拖动中 + 松手后 400ms 内不清 pending——
    // mock 反馈始终滞后于本地预览，中途清了下一帧反馈会把模型往回拽出可见抖动。
    if (dragState.draggingArm === jointArm) return
    if (performance.now() - dragState.lastDragEndAt < 400) return
    if (Math.abs(measured - pending.angle) < 0.5 * DEG2RAD) {
      pending.matches += 1
      if (pending.matches >= 3) {
        spawnBurst(jointName)
        pendingJointTargets.delete(jointName)
        delete jointPending.value[jointName]   // P0：反馈到位，同步清除 pending 状态
      }
    } else pending.matches = 0
  }

  function spawnBurst(jointName: string): void {
    const marker = jointMarkers.find(m => m.userData.jointName === jointName)
    if (!marker) return
    const origin = marker.getWorldPosition(new THREE.Vector3())
    activeBursts.push(new ParticleBurst(scene, origin))
  }

  function updateJointHover(): void {
    // P3：悬停逻辑下沉 scene/markers.ts（容器注入共享引用）
    markersCtl?.updateJointHover()
  }

  /**
   * 关节球做屏幕空间命中：3D Raycaster 在模型密集时容易被遮挡，
   * 而操作球本身就是 HUD 标记，必须优先于模型命中。
   */
  function findJointMarkerByPointer(radiusPx = 34): THREE.Mesh | null {
    // P3：屏幕命中下沉 scene/markers.ts
    return markersCtl?.findJointMarkerByPointer(radiusPx) ?? null
  }

  /** 底盘球命中（与关节球同法屏幕空间投影：HUD 球优先于模型 Raycaster）。 */
  function findChassisMarkerByPointer(radiusPx = 40): THREE.Mesh | null {
    // P3：屏幕命中下沉 scene/markers.ts
    return markersCtl?.findChassisMarkerByPointer(radiusPx) ?? null
  }

  /** 头部球命中（与底盘球同法屏幕空间投影：HUD 球优先于模型 Raycaster）。 */
  function findHeadMarkerByPointer(radiusPx = 40): THREE.Mesh | null {
    // P3：屏幕命中下沉 scene/markers.ts
    return markersCtl?.findHeadMarkerByPointer(radiusPx) ?? null
  }

  /** 底盘值域钳位：lift=绝对高度 mm（903.3~1453.3）/ bend=弯腰 °（±90）。 */
  function clampChassisValue(axis: 'lift' | 'bend', value: number): number {
    // P3：值域钳制下沉 scene/markers.ts
    return markersCtl?.clampChassisValue(axis, value) ?? value
  }

  function updateChassisHover(): void {
    // P3：悬停逻辑下沉 scene/markers.ts（容器注入共享引用）
    markersCtl?.updateChassisHover()
  }

  // ═══ M4 拖动模式：腕部单拖动手柄 + 前端数值 IK（2026-08-30 单环改版） ═══
  // 交互范式（用户定稿"只需要一个腕关节"）：每臂只保留腕端 tool0 一个琥珀拖动环——
  //   纯左键 = 位置跟随（整臂 7 关节 IK）——主交互；
  //   Shift+左键 = 空间角度（保持 TCP 位置、旋转末端姿态，6D IK）；
  //   Alt+左键 = 多动角度（J2~J7 链动微调）。
  //   ⚠️ 关节球 = M4 下完全隐藏（只留这一个拖动环，见 updateDragModeUI）。
  // 目标均经 30Hz topic 流下发（与关节球拖动同一通道）。

  // ═══ 统一拖动会话（2026-08-30 彻底重构，替代 dragState/ikState/headDrag/chassisDrag）═══
  // 设计：所有拖动（关节球/拖动环/头部球/底盘球）收敛为单一 dragState.activeDrag 状态机。
  //   onPointerDown → 命中路由 → beginDrag(session)
  //   onPointerMove → 只调 dragState.activeDrag.update(e)
  //   onPointerUp   → 只调 dragState.activeDrag.end(e)
  // 统一出口：arm 走 applyDragSolution（限位+单帧钳制+jointPositions 同步+registerPending）
  //           并 sendArmCommand（节流下发）；head/chassis 走各自 preview+command 出口。
  // 统一反馈抑制：feedbackHeld() 判定（拖动中 / 松手 400ms / M4）。

  // ═══ 控制球显隐策略（2026-08-30 用户反馈，三类球统一）═══
  // 默认隐藏；双击关节球只显示该球、双击整臂显示该臂 7 球；
  // 双击头部显示 yaw+pitch 两球、双击单个头部球只留该球；
  // 双击底盘/躯干显示 lift+bend 两球、双击单个底盘球只留该球；
  // 双击空白/复位清空。M4 拖动模式下彻底隐藏对应臂关节球 + 全部头部/底盘球
  //（只留拖动手环），避免球环混杂难操作。
  const visibleJointMarkers = new Set<string>()
  const visibleHeadMarkers = new Set<'yaw' | 'pitch'>()
  const visibleChassisMarkers = new Set<'lift' | 'bend'>()
  function applyMarkerVisibility(): void {
    // 手臂关节球（含 M4 半透明逻辑）
    for (const m of jointMarkers) {
      const name = m.userData.jointName as string
      if (!name) continue
      const side = name.endsWith('_L') ? 'L' : 'R'
      const m4 = dragState.dragModeActive[side]
      const show = !m4 && visibleJointMarkers.has(name)
      m.visible = show
      const label = jointHoverLabels[name]
      if (label) (label.element as HTMLElement).style.display = 'none'
    }
    // 头部球
    for (const m of headMarkers) {
      const a = m.userData.headAxis as 'yaw' | 'pitch'
      m.visible = visibleHeadMarkers.has(a)
      const lab = headHoverLabels[a]
      if (lab) (lab.element as HTMLElement).style.display = 'none'
    }
    // 底盘球
    for (const m of chassisMarkers) {
      const a = m.userData.chassisAxis as 'lift' | 'bend'
      m.visible = visibleChassisMarkers.has(a)
      const lab = chassisHoverLabels[a]
      if (lab) (lab.element as HTMLElement).style.display = 'none'
    }
  }

  /** 创建每臂单个拖动手柄：腕部 TCP（tool0 末端，直观跟手），默认隐藏。
   *  2026-08-30 用户定稿：拖动只需要一个腕关节手柄，去掉肘部环——单环交互最直觉。 */
  function createDragHandles(): void {
    for (const side of ARM_SIDES) {
      // TCP 环锚点：tool0 末端坐标系（0,0,0=腕端），拖动环随腕端 FK 自动跟手。
      const tool0 = (robotGroup.children[0] as any)?.getObjectByName?.(`tool0_${side}`)
      if (!tool0) continue
      const handle = new THREE.Mesh(
        new THREE.TorusGeometry(0.055, 0.011, 12, 36),
        new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.95 }))
      handle.userData.side = side
      handle.visible = false
      tool0.add(handle)
      handle.position.set(0, 0, 0)
      // 手柄上方常显标签（复用 joint-hover 样式）
      const tag = document.createElement('div')
      tag.className = 'joint-hover'
      tag.textContent = '腕部拖动'
      tag.style.display = 'none'
      const tagObj = new CSS2DObject(tag)
      tagObj.position.set(0, 0.075, 0)
      handle.add(tagObj)
      labelObjs.push(tagObj)
      dragState.dragHandles[side] = handle
    }
  }

  /** 每帧刷新拖动模式 UI（2026-08-30 单环改版）：M4 且未锁定 → 该臂关节球完全隐藏、
   *  只显示腕部单个拖动环；头部/底盘球也一并隐藏，画面只留环最干净。 */
  function updateDragModeUI(): void {
    // 任一臂处于 M4 拖动 → 头部/底盘球也整体隐藏（只留拖动环，画面最干净）；
    // 退出拖动后按各自显隐集合恢复（双击显式出现的口径不变，2026-08-30）
    const anyDrag = ARM_SIDES.some(s => dragState.dragModeActive[s])
    for (const m of headMarkers) {
      const a = m.userData.headAxis as 'yaw' | 'pitch'
      m.visible = !anyDrag && visibleHeadMarkers.has(a)
      const lab = headHoverLabels[a]
      if (lab) (lab.element as HTMLElement).style.display = 'none'
    }
    for (const m of chassisMarkers) {
      const a = m.userData.chassisAxis as 'lift' | 'bend'
      m.visible = !anyDrag && visibleChassisMarkers.has(a)
      const lab = chassisHoverLabels[a]
      if (lab) (lab.element as HTMLElement).style.display = 'none'
    }
    for (const side of ARM_SIDES) {
      const arm = side === 'L' ? robotStore.armL : robotStore.armR
      const dragActive = arm.mode === 4 && !arm.estop && !arm.fault && modelLoaded.value
      if (dragActive === dragState.dragModeActive[side]) continue
      dragState.dragModeActive[side] = dragActive
      // 2026-08-31：进入 M4 拖动 → 清除该臂的关节键选（M4 下该臂关节球已隐藏，
      // 遗留选中会让 Shift+W 走关节大步而非 TCP 步进，与拖动浮条提示冲突）
      if (dragActive && dragState.kbSelected && dragState.kbSelected.side === side) dragState.kbSelected = null
      for (const m of jointMarkers) {
        const name = m.userData.jointName as string
        if (!name.endsWith(`_${side}`)) continue
        // 2026-08-30（用户反馈）：M4 下关节球完全隐藏，只留拖动手环——球环混杂难操作；
        // 退出 M4 时按 visibleJointMarkers 集合恢复显隐（双击显式出现的口径不变）
        const show = !dragActive && visibleJointMarkers.has(name)
        m.visible = show
        const label = jointHoverLabels[name]
        if (label) (label.element as HTMLElement).style.display = 'none'
      }
      const handle = dragState.dragHandles[side]
      if (!handle) continue
      handle.visible = dragActive
      const tag = (handle.children.find(c => (c as CSS2DObject).element) as CSS2DObject | undefined)
      if (tag) (tag.element as HTMLElement).style.display = dragActive ? 'block' : 'none'
    }
  }

  /** 拖动手柄屏幕空间命中（唯一腕部环，HUD 元素优先于模型 Raycaster）。 */
  function findDragHandleByPointer(radiusPx = 52): THREE.Mesh | null {
    const rect = renderer.domElement.getBoundingClientRect()
    let nearest: THREE.Mesh | null = null
    let nearestDistance = radiusPx
    for (const handle of Object.values(dragState.dragHandles)) {
      if (!handle || !handle.visible) continue
      const projected = handle.getWorldPosition(new THREE.Vector3()).project(camera)
      if (projected.z > 1) continue
      const x = (projected.x * .5 + .5) * rect.width + rect.left
      const y = (-projected.y * .5 + .5) * rect.height + rect.top
      const px = (mouse.x * .5 + .5) * rect.width + rect.left
      const py = (-mouse.y * .5 + .5) * rect.height + rect.top
      const distance = Math.hypot(x - px, y - py)
      if (distance < nearestDistance) { nearestDistance = distance; nearest = handle }
    }
    return nearest
  }

  /** 解 3x3 线性方程组（高斯消元；DLS 已加阻尼，A 视为非奇异）。 */
  /**
   * 数值 IK（阻尼最小二乘）：目标 = 手柄锚点世界位置，姿态不约束（拖动只关心点位）。
   * 雅可比用前向差分（直接以场景图 FK 为真值，无需独立运动学模型）；
   * 每迭代步幅钳制 ±0.05rad，配合关节限位钳制，保证收敛过程不超限不跳变。
   * 注：DLS 数学核心（solve3x3/矩阵构造）已下沉 utils/robotMath（P1）。
   * @param handle  IK 的跟随锚点对象（腕部 TCP 手柄），其世界位置即被拖动的点
   * @param mask    参与解算的关节序号集；null=全部 7 关节（当前唯一用法：整臂跟随）。
   */
  function solveArmIK(side: 'L' | 'R', targetWorld: THREE.Vector3, angles: number[],
                      handle: THREE.Object3D, mask: number[] | null): number[] {
    // P3：IK 数值解算下沉 scene/ik.ts，本文件仅注入 robot 场景图（原签名/调用点不变）
    return ikSolveArmIK(side, targetWorld, angles, robotGroup.children[0] as any, handle, mask)
  }

  /** 解 N×N 线性方程组（高斯消元，带主元选择；DLS 已加阻尼视为非奇异）。
   *  6D IK 需要 6×6 求解，3D 拖动仍走 solve3x3。注：实现已下沉 utils/robotMath（P1）。 */

  /** FK 正解：取 tool0 link（URDF `tool0_L/R`，模型域）的世界位姿。
   *  用于踩点（记录 xyz+quat）与回放目标校验。返回 null 表示模型未就绪。 */
  function computeTool0(side: 'L' | 'R'): { pos: THREE.Vector3; quat: THREE.Quaternion } | null {
    // P3：FK 正解下沉 scene/ik.ts（注入 robot 场景图，原签名不变）
    return ikComputeTool0(side, robotGroup.children[0] as any)
  }

  /** 四元数 → 旋转矢量（轴角×角度），用于姿态误差度量。实现已下沉 utils/robotMath（P1）。 */

  /**
   * 6D 数值 IK（阻尼最小二乘）：目标 = tool0 世界位姿（位置 + 姿态）。
   * 在 solveArmIK（仅位置）基础上扩展：误差从 3 维扩到 6 维（位置误差 +
   * 姿态旋转矢量误差），雅可比姿态行用 tool0 旋转矩阵前向差分，保证
   * 踩点回放时不仅"末端点到位"而且"姿态对齐"（仿人手臂方向自然）。
   * @param handle IK 跟随锚点对象（其世界位姿即 tool0）
   * @param mask 参与解算关节序号集（null=全部 7 关节）
   */
  function solveArmIK6D(
    side: 'L' | 'R',
    targetPos: THREE.Vector3,
    targetQuat: THREE.Quaternion,
    angles: number[],
    handle: THREE.Object3D,
    mask: number[] | null,
  ): number[] {
    // P3：6D IK 下沉 scene/ik.ts（注入 robot 场景图，原签名/调用点不变）
    return ikSolveArmIK6D(side, targetPos, targetQuat, angles, robotGroup.children[0] as any, handle, mask)
  }

  /** App 收到 /joint_states 时可直接复用；也可在状态桥中逐轴调用。 */
  function notifyJointFeedback(jointName: string, angleRad: number): void {
    checkJointSettled(jointName, angleRad)
  }

  /** P-B 公开包装：按 tool0 目标位姿反解关节角（供 useTeach 点选执行）。
   *  内部自动定位 tool0 link 作 IK 锚点；模型未就绪或解算失败返回原角度。 */
  function solveTool0IK6D(
    side: 'L' | 'R',
    targetPos: THREE.Vector3,
    targetQuat: THREE.Quaternion,
    angles: number[],
  ): number[] {
    // P3：tool0 IK 包装下沉 scene/ik.ts（注入 robot 场景图，原签名不变）
    return ikSolveTool0IK6D(side, targetPos, targetQuat, angles, robotGroup.children[0] as any)
  }

  /** 夹爪开度跟随（用户反馈"设置开度 3D 不动"）：夹爪驱动不发 /joint_states，
   *  Web 端把 GripperStatus.position（0~0.06m 开口）映射为 URDF prismatic
   *  gripper_X_joint（单指 0~0.03m stroke，开口/2=单指行程；URDF 已同步 0.03）。
   *  2026-08-31 语义修正：开口=两指张开距离 60mm，两指对称各动一半。 */
  function driveGripper(side: 'L' | 'R', positionM: number): void {
    const stroke = THREE.MathUtils.clamp(positionM / 2, 0, 0.03)
    jointPositions.value[`gripper_${side}_joint`] = stroke
    const robot = robotGroup.children[0] as any
    robot?.setJointValues({ [`gripper_${side}_joint`]: stroke })
  }

  /** Inspector 的滑杆输入需立即投影到 3D 并抑制反馈回写。 */
  function previewJointTarget(jointName: string, angleRad: number): void {
    const side = jointName.endsWith('_L') ? 'L' : 'R'
    const jointIndex = Number(jointName.match(/^Joint(\d)/)?.[1] ?? 1) - 1
    const angle = clampJointValue(jointName, angleRad)
    jointPositions.value[jointName] = angle
    registerPending(jointName, angle)
    const robot = robotGroup.children[0] as any
    // ★ 2026-09-03 模型侧方向校准：preview 也要对模型取反（与 applyDragSolution 同口径）
    //   jointPositions 存原始值，setJointValues 需要模型侧反转值。
    const baseName = jointName.replace(/_[LR]$/, '')
    const modelAngle = shouldInvert(side, baseName) ? -angle : angle
    robot?.setJointValues(Object.fromEntries(ARM_JOINTS.map((n, i) => {
      const fullName = `${n}_${side}`
      if (i === jointIndex) return [fullName, modelAngle]
      // 其他关节：jointPositions 已是原始值，需按模型侧取反
      const bn = n
      const raw = jointPositions.value[fullName] ?? 0
      return [fullName, shouldInvert(side, bn) ? -raw : raw]
    })))
  }

  // ═══ CSS2D 浮动标签（P3 已下沉 scene/labels.ts）═══
  // labelObjs/allLabels 保留在本文件：hover 标签（关节/底盘/头部）与拖动手柄标签
  // 仍 push 到这两个数组，随场景卸载统一 remove/dispose（见 onUnmounted）。
  const labelObjs: CSS2DObject[] = []
  const allLabels: HTMLElement[] = []
  // robotLabels 控制器：模型加载后构造（见加载回调中 createRobotLabels 调用点）
  let robotLabels: RobotLabels | null = null


  // ═══ 部位拾取（2026-09-02 下沉 scene/pick.ts，行为原样迁移）═══
  // Raycaster 命中/双击路由/部件高亮/HUD 投屏由 createPickController 提供（依赖注入）；
  // 本文件保留 mouse（与拖动状态机共享）、eventCleanup（拖动+拾取共用清理登记），
  // 对外仅薄转发 applyPartOpacity/projectPartToScreen（return 与 E2E 接口不变）。
  const mouse = new THREE.Vector2()   // 归一化指针（拾取 updatePointer 与拖动 setPointer 共写）
  const eventCleanup: (() => void)[] = []
  const pickCtl = createPickController({
    renderer, camera, container, mouse, robotGroup, placeholderGroup, modelLoaded,
    selectedPart, focusMode,
    visibleJointMarkers, visibleHeadMarkers, visibleChassisMarkers, applyMarkerVisibility,
    findJointMarkerByPointer, findHeadMarkerByPointer, findChassisMarkerByPointer,
    dragState, eventCleanup, flyTo, resetToHome, options,
  })

  /** 部件高亮薄转发（cameraController.onResetScene 复位场景仍走此入口）。 */
  function applyPartOpacity(partId: string | null): void {
    pickCtl.applyPartOpacity(partId)
  }


  // ═══ 渲染循环 ═══
  const clock = new THREE.Clock()
  let rafId = 0
  function animate(): void {
    rafId = requestAnimationFrame(animate)
    const dt = clock.getDelta()
    const t = clock.elapsedTime
    updateJointHover()
    updateChassisHover()   // 底盘升降/弯腰球悬停高亮（2026-08-29）
    updateHeadHover()      // 头部摇头/点头球悬停高亮（2026-08-30）
    updateDragModeUI()
    // P0 pending 超时（自适应）：基础 2s + 每度距离 40ms（上限 +6s）——
    // Mock 以 velocity_pct=10 低速跟随，大角度（如 160°）2s 内本就到不了位，
    // 固定 2s 会频繁误报"反馈超时"。反馈到位或超时才解除本地目标抑制。
    // 2026-09-02（M4 反馈口径修正）：M4 下 pending 一律清除——反馈即权威，与
    // checkJointSettled 的 M4 分支同口径；反馈断流时模型停在最后反馈位（不再被
    // 本地目标长期屏蔽）。
    const nowMs = performance.now()
    for (const [name, p] of pendingJointTargets) {
      const arm = name.endsWith('_L') ? robotStore.armL : robotStore.armR
      if (arm.mode === 4) { pendingJointTargets.delete(name); delete jointPending.value[name]; continue }
      const fb = lastFeedbackRad.get(name) ?? p.angle
      const distDeg = Math.abs(p.angle - fb) / DEG2RAD
      const timeout = PENDING_TIMEOUT_MS + Math.min(distDeg * 40, 6000)
      if (nowMs - p.sentAt > timeout) {
        pendingJointTargets.delete(name)
        const st = jointPending.value[name]
        if (st) jointPending.value[name] = { ...st, timedOut: true }
      }
    }
    if (!focusMode.value) {
      // 全景模式下整机缓慢呼吸浮动 + 模型未就位时兜底自转
      robotGroup.position.y = Math.sin(t * 0.8) * 0.006
      if (!modelLoaded.value) placeholderGroup.rotation.y = t * 0.2
    }
    // ═══ 装饰背景动画（P2 下沉 scene/background.ts）═══
    // 太阳系进动/行星公转自转/小行星带差速/星点旋转/光环巡航/星云时间全部由
    // background.update 管理；dim=聚焦暗化系数（0.12 聚焦 / 1 全景），内部做缓存去抖。
    background.update(t, dt, focusMode.value ? 0.12 : 1)
    for (let i = activeBursts.length - 1; i >= 0; i--) {
      if (activeBursts[i].update(dt)) {
        activeBursts[i].dispose(scene)
        activeBursts.splice(i, 1)
      }
    }
    controls.update()
    // 选择性 Bloom 两步渲染（P2 下沉）：background.render 内部完成
    // GLOW 层切换/mask 保存恢复 + 辉光纹理 + 主通道叠加输出。
    background.render(camera)
    css2dRenderer.render(scene, camera)
  }
  animate()

  // ═══ 窗口自适应 ═══
  function onResize(): void {
    if (!container.clientWidth) return
    camera.aspect = container.clientWidth / container.clientHeight
    camera.updateProjectionMatrix()
    renderer.setSize(container.clientWidth, container.clientHeight)
    background.setSize(container.clientWidth, container.clientHeight)   // 两级后处理链同步缩放（P2）
    css2dRenderer.setSize(container.clientWidth, container.clientHeight)
  }
  window.addEventListener('resize', onResize)

  /** 供 SVG HUD 连接线使用（P3+ 下沉 scene/pick.ts，薄转发；E2E partScreen 同源）。 */
  function projectPartToScreen(partId: string): { x: number; y: number } | null {
    return pickCtl.projectPartToScreen(partId)
  }

  // 初始相机姿态在场景构造后保存；Esc/双击空白/关闭 Inspector 都严格回到这一姿态。
  const homeView = { camera: camera.position.clone(), target: controls.target.clone() }
  // P3：相机控制器在 homeView 快照就绪后构造（注入复位场景副作用回调——
  // 清三类控制球显隐 + 应用 + 模型透明度复原，与旧 resetToHome 内联逻辑一致）。
  cameraController = createCameraController({
    camera, controls, focusMode, homeView,
    onResetScene: () => {
      visibleJointMarkers.clear()
      visibleHeadMarkers.clear()
      visibleChassisMarkers.clear()
      applyMarkerVisibility()
      applyPartOpacity(null)
    },
    onReset: options.onReset,
  })
  /** 复位回全景（P3 薄封装，转发 cameraController.resetToHome）。 */
  /** 相机飞行动画薄封装（P3 已下沉 scene/camera.ts；拾取双击聚焦经 deps.flyTo 调用）。 */
  function flyTo(target: THREE.Object3D): void {
    cameraController?.flyTo(target)
  }

  function resetToHome(): void {
    cameraController?.resetToHome()
  }

  // ═══ 卸载清理（防内存泄漏）═══
  onUnmounted(() => {
    cancelAnimationFrame(rafId)
    window.removeEventListener('resize', onResize)
    eventCleanup.forEach(fn => fn())
    controls.dispose()
    activeBursts.forEach(p => p.dispose(scene))
    jointMarkers.forEach(m => {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose()
    })
    chassisMarkers.forEach(m => {   // 底盘控制球同法释放（2026-08-29）
      m.geometry.dispose();
      (m.material as THREE.Material).dispose()
    })
    headMarkers.forEach(m => {      // 头部控制球同法释放（2026-08-30）
      m.geometry.dispose();
      (m.material as THREE.Material).dispose()
    })
    scene.environment?.dispose()
    pmrem.dispose()
    scene.traverse(o => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh) {
        mesh.geometry.dispose()
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        materials.forEach(m => m.dispose())
      }
      const points = o as THREE.Points
      if (points.isPoints) {
        points.geometry.dispose();
        (points.material as THREE.Material).dispose()
      }
    })
    renderer.dispose()
    allLabels.forEach(el => el.remove())
    // 装饰背景资源（P2）：星点/光环/太阳系/星云材质几何 + 行星 CSS2D 标签 DOM
    // 由 background.dispose 统一释放（行星贴图由 TextureLoader 加载，随遍历 dispose 覆盖）。
    background.dispose(scene)
  })

  return {
    updateJoints, selectedPart, focusMode, modelLoaded, resetView: resetToHome, jointPositions, driveGripper,
    jointLimits,
    previewJointTarget,
    previewChassis,      // 底盘 3D 即时预览（拖动/面板下发用，无抑制窗口）
    followChassis,       // 底盘反馈跟随入口（App 状态 watch 专用：拖动/缓冲期丢弃反馈）
    previewHead,         // 头部 3D 即时预览（HeadPanel 下发/拖动用）
    followHead,          // 头部反馈跟随入口（App 状态 watch 专用：拖动/缓冲期丢弃反馈）
    clearKbSelection,    // 清除键盘微调选中（App Esc/关面板/退出拖动时调用）
    notifyJointFeedback, projectPartToScreen,
    computeTool0,        // FK 正解：tool0 世界位姿（踩点/回放目标校验，P-B）
    solveArmIK6D,        // 6D 数值 IK（位置+姿态，踩点回放轨迹反解，P-B）
    solveTool0IK6D,      // P-B 公开包装：tool0 目标位姿 → 关节角（useTeach 点选执行）
  }
}
