/**
 * @file    background.ts
 * @brief   3D 场景装饰背景模块：星点/双层光环/太阳系/星云 + 选择性 Bloom 后处理
 * @author Csihan
 * @date    2026-09-01
 *
 * 设计（P2 装饰性 3D 拆出，2026-09-01）：
 *   - 从 useRobot3D.ts 剥离纯装饰对象（星点/光环/行星/轨道/小行星带/星云）与
 *     两级 Bloom 后处理（bloomComposer/finalComposer/mixPass），全部收进本模块；
 *   - 只暴露最小接口：createBackground(scene, renderer, container) → Background
 *     （含 finalComposer / update / setSize / dispose），useRobot3D 只做装配与调用；
 *   - 代码「原样迁移」自 useRobot3D.ts（P2 目标），不重写渲染/动画逻辑，
 *     保证 240fps 视觉与重构前逐帧一致；
 *   - 依赖仅用 three.js 官方 addons（EffectComposer/UnrealBloomPass/CSS2D 等）。
 */

import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { AdditiveBlending } from 'three'

/**
 * GLOW 层编号：宇宙氛围元素专用层（星点/双层光环/爆发粒子等发光背景）。
 * 机器人本体、拖动环、关节球等交互元素保持 layer 0 —— 这是"选择性 Bloom"
 * 的隔离边界：Bloom 通道只渲染本层，模型再亮也不会被辉光吞掉（用户口径）。
 * 注：由 useRobot3D 的 ParticleBurst 复用，故一并导出。
 */
export const GLOW_LAYER = 1

/** 圆形光点贴图：canvas 径向渐变（PointsMaterial 默认方点 → 柔和圆点）。 */
export function makeCircleTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,.9)')
  g.addColorStop(0.7, 'rgba(255,255,255,.28)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
export const dotTex = makeCircleTexture()

/** 背景控制器：useRobot3D 通过它驱动动画/缩放/渲染/释放，不直接触碰内部对象。 */
export interface Background {
  /** 每帧渲染：选择性 Bloom 两步（先 GLOW 层出辉光纹理，再整场景叠加输出）。 */
  render(camera: THREE.Camera): void
  /** 每帧动画：太阳系公转/自转、星点旋转、光环巡航、星云时间、聚焦暗化。 */
  update(t: number, dt: number, dim: number): void
  /** 窗口缩放：两级后处理链同步（setSize 内部已含 pixelRatio）。 */
  setSize(w: number, h: number): void
  /** 卸载释放：后处理/材质/几何/环境贴图全部 dispose。 */
  dispose(scene: THREE.Scene): void
  /** 辉光通道（控制台调参钩子：`__marvin3d.bloom.strength/.radius/.threshold`）。 */
  bloomPass: UnrealBloomPass
}

/**
 * 创建全部装饰背景（原 useRobot3D.ts 280~553 行原样迁移）。
 * @param scene     主场景（装饰对象直接 add）
 * @param camera    共享相机（Bloom 渲染通道与 GLOW 层切换需要）
 * @param renderer  WebGLRenderer（后处理链依赖）
 * @param container 挂载容器（宽高供 Bloom/主通道尺寸）
 */
export function createBackground(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
  container: HTMLElement,
): Background {
  // ═══ 网格地板 + 粒子星域 ═══
  const grid = new THREE.GridHelper(8, 32, 0x1a3a5c, 0x0d2038)
  grid.position.y = -0.01
  scene.add(grid)
  const starGeo = new THREE.BufferGeometry()
  const starPos = new Float32Array(2600 * 3)
  const starColor = new Float32Array(2600 * 3)
  const palette = [new THREE.Color(0x8ef6ff), new THREE.Color(0x9d7bff), new THREE.Color(0xffffff), new THREE.Color(0x4bd0ff),
    new THREE.Color(0xffb86b), new THREE.Color(0xff7ac2), new THREE.Color(0x7cffd4), new THREE.Color(0xc2b8ff)]
  for (let i = 0; i < starPos.length; i += 3) {
    starPos[i] = (Math.random() - .5) * 42
    starPos[i + 1] = Math.random() * 20 - 3
    starPos[i + 2] = (Math.random() - .5) * 42
    const c = palette[Math.floor(Math.random() * palette.length)]
    starColor[i] = c.r; starColor[i + 1] = c.g; starColor[i + 2] = c.b
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
  starGeo.setAttribute('color', new THREE.BufferAttribute(starColor, 3))
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
    size: .03, vertexColors: true, transparent: true, opacity: .95, map: dotTex, fog: false,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }))
  scene.add(stars)

  // ═══ 倾斜粒子光环（双层错位环带：内环贴地、外环稍高，青白双色 + 加法混合）═══
  const haloGroup = new THREE.Group()
  const haloPalette = [0x6ff5e8, 0xbdfaff, 0x4bd0ff, 0xffffff]
  function makeHaloRing(radius: number, yBase: number, count: number, size: number, opacity: number): THREE.Points {
    const posArr = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2
      const rad = radius + (Math.random() - 0.5) * 0.34
      posArr[i * 3] = Math.cos(ang) * rad
      posArr[i * 3 + 1] = yBase + (Math.random() - 0.5) * 0.16
      posArr[i * 3 + 2] = Math.sin(ang) * rad
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3))
    const c = new THREE.Color(haloPalette[Math.floor(Math.random() * haloPalette.length)])
    const mat = new THREE.PointsMaterial({
      color: c, size, transparent: true, opacity, map: dotTex, fog: false,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
    return new THREE.Points(geo, mat)
  }
  const haloA = makeHaloRing(2.15, 0.34, 900, 0.020, 0.50)
  const haloB = makeHaloRing(2.62, 0.72, 620, 0.016, 0.36)
  haloB.rotation.x = -0.10          // 外环轻微反向倾斜，形成交错观感
  haloGroup.add(haloA)
  haloGroup.add(haloB)
  scene.add(haloGroup)

  // 背景（星点/双层光环）登记进 GLOW 层，机器人与行星保持 layer 0。
  for (const glowObj of [stars, haloA, haloB]) glowObj.layers.enable(GLOW_LAYER)

  // ═══ 太阳系场景（2026-08-31，用户需求：机器人模型替代太阳居于中心）═══
  // 结构：solarGroup（根）→ orbitLines（8 条轨道环）+ planetAnchors（行星锚点）+ beltPts（小行星带）。
  // 公转实现：每帧对行星锚点 rotation.y += 角速度·dt，行星局部 X 偏移即轨道半径 → 天然做圆周运动。
  const solarGroup = new THREE.Group()
  const PLANETS: Array<{
    name: string; dist: number; radius: number
    speed: number; spin: number
    map: string; bump?: string; bumpScale?: number
    ring?: { inner: number; outer: number; color: string; tilt: number; map?: string; alphaMap?: string }
  }> = [
    { name: '水星', dist: 3.2,  radius: 0.10, speed: 0.160, spin: 0.10,
      map: '/models/planets/mercurymap.jpg', bump: '/models/planets/mercurybump.jpg', bumpScale: 0.005 },
    { name: '金星', dist: 3.95, radius: 0.16, speed: 0.118, spin: -0.04,
      map: '/models/planets/venusmap.jpg', bump: '/models/planets/venusbump.jpg', bumpScale: 0.005 },  // 自转逆行
    { name: '地球', dist: 4.7,  radius: 0.17, speed: 0.100, spin: 0.42,
      map: '/models/earth/earth_atmos_2048.jpg', bump: '/models/earth/earth_normal_2048.jpg', bumpScale: 0.6,
      ring: { inner: 0.23, outer: 0.30, color: '#8fb6ff', tilt: 0.30 } },   // 大气辉环
    { name: '火星', dist: 5.45, radius: 0.13, speed: 0.081, spin: 0.40,
      map: '/models/planets/marsmap1k.jpg', bump: '/models/planets/marsbump1k.jpg', bumpScale: 0.005 },
    { name: '木星', dist: 6.7,  radius: 0.42, speed: 0.044, spin: 0.90,
      map: '/models/planets/jupitermap.jpg',
      ring: { inner: 0.52, outer: 0.60, color: '#a88d6a', tilt: 0.12 } },   // 木星细环
    { name: '土星', dist: 8.0,  radius: 0.36, speed: 0.032, spin: 0.82,
      map: '/models/planets/saturnmap.jpg',
      ring: { inner: 0.48, outer: 0.72, color: '#d9c08e', tilt: 0.47,
        map: '/models/planets/saturnringcolor.jpg', alphaMap: '/models/planets/saturnringpattern.gif' } },
    { name: '天王星', dist: 9.3, radius: 0.24, speed: 0.023, spin: -0.55,
      map: '/models/planets/uranusmap.jpg',
      ring: { inner: 0.33, outer: 0.40, color: '#7fb8c0', tilt: 1.71,
        map: '/models/planets/uranusringcolour.jpg', alphaMap: '/models/planets/uranusringtrans.gif' } },
    { name: '海王星', dist: 10.5, radius: 0.23, speed: 0.018, spin: 0.52,
      map: '/models/planets/neptunemap.jpg' },
  ]
  const orbitLineMat = new THREE.MeshBasicMaterial({
    color: 0x2f5f8f, transparent: true, opacity: 0.38,
    side: THREE.DoubleSide, blending: AdditiveBlending, depthWrite: false,
  })
  const radarRing = new THREE.Mesh(new THREE.RingGeometry(2.62, 2.70, 96), orbitLineMat.clone())
  radarRing.rotation.x = -Math.PI / 2
  radarRing.position.y = 0.02
  scene.add(radarRing)
  const ECLIPTIC_Y = 1.1          // 黄道面高度：约机器人胸口高度
  const orbitGeoCache = new THREE.RingGeometry(0.997, 1.003, 128)
  const planetTexLoader = new THREE.TextureLoader()
  const loadPlanetTex = (url: string, srgb: boolean): THREE.Texture => {
    const t = planetTexLoader.load(url)
    if (srgb) t.colorSpace = THREE.SRGBColorSpace
    return t
  }

  const planetAnchors: Array<{ anchor: THREE.Group; speed: number; mesh: THREE.Mesh; spin: number }> = []
  const planetLabels: CSS2DObject[] = []
  for (const p of PLANETS) {
    // 轨道环线：单位圆模板 scale 到轨道半径；双面渲染保证俯视/仰视都可见
    const line = new THREE.Mesh(orbitGeoCache, orbitLineMat)
    line.scale.setScalar(p.dist)
    line.rotation.x = -Math.PI / 2
    line.position.y = ECLIPTIC_Y
    solarGroup.add(line)
    const anchor = new THREE.Group()
    anchor.position.y = ECLIPTIC_Y
    anchor.rotation.y = Math.random() * Math.PI * 2   // 初始相位随机
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(p.radius, 40, 28),
      new THREE.MeshStandardMaterial({
        map: loadPlanetTex(p.map, true),
        bumpMap: p.bump ? loadPlanetTex(p.bump, false) : null,
        bumpScale: p.bumpScale ?? 0,
        metalness: 0.08, roughness: 0.85,
      }),
    )
    mesh.position.x = p.dist
    anchor.add(mesh)
    if (p.ring) {
      const ringGeo = new THREE.RingGeometry(p.ring.inner, p.ring.outer, 96)
      const posAttr = ringGeo.attributes.position
      const uvAttr = ringGeo.attributes.uv
      const v3 = new THREE.Vector3()
      for (let i = 0; i < posAttr.count; i++) {
        v3.fromBufferAttribute(posAttr, i)
        uvAttr.setXY(i, (v3.length() - p.ring.inner) / (p.ring.outer - p.ring.inner), 0.5)
      }
      uvAttr.needsUpdate = true
      const ringMesh = new THREE.Mesh(ringGeo, new THREE.MeshStandardMaterial({
        map: p.ring.map ? loadPlanetTex(p.ring.map, true) : null,
        alphaMap: p.ring.alphaMap ? loadPlanetTex(p.ring.alphaMap, false) : null,
        color: p.ring.map ? 0xffffff : new THREE.Color(p.ring.color),
        transparent: true, opacity: 0.95,
        side: THREE.DoubleSide, depthWrite: false,
      }))
      ringMesh.rotation.x = Math.PI / 2 - p.ring.tilt   // 环面倾角（土星 26.7°、天王星 97.8° 等）
      ringMesh.position.x = p.dist
      anchor.add(ringMesh)
    }
    // 行星名标签：CSS2D 小字，随公转移动
    const labelEl = document.createElement('div')
    labelEl.textContent = p.name
    labelEl.style.cssText = 'font-size:10px;letter-spacing:2px;color:#7dd8ff;opacity:.75;text-shadow:0 0 6px rgba(0,200,255,.6);pointer-events:none;white-space:nowrap'
    const label = new CSS2DObject(labelEl)
    label.position.set(p.dist, p.radius + 0.18, 0)
    anchor.add(label)
    planetLabels.push(label)
    solarGroup.add(anchor)
    planetAnchors.push({ anchor, speed: p.speed, mesh, spin: p.spin })
  }
  // 小行星带（火星 5.45 与木星 6.7 之间取 6.05）：1400 颗碎岩粒子的薄环带
  const beltCount = 1400
  const beltPos = new Float32Array(beltCount * 3)
  for (let i = 0; i < beltCount; i++) {
    const ang = Math.random() * Math.PI * 2
    const rad = 6.05 + (Math.random() - 0.5) * 0.85
    beltPos[i * 3] = Math.cos(ang) * rad
    beltPos[i * 3 + 1] = ECLIPTIC_Y + (Math.random() - 0.5) * 0.14
    beltPos[i * 3 + 2] = Math.sin(ang) * rad
  }
  const beltGeo = new THREE.BufferGeometry()
  beltGeo.setAttribute('position', new THREE.BufferAttribute(beltPos, 3))
  const beltPts = new THREE.Points(beltGeo, new THREE.PointsMaterial({
    color: 0x9a8f80, size: 0.035, transparent: true, opacity: 0.65, map: dotTex, fog: false,
    blending: AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }))
  solarGroup.add(beltPts)
  scene.add(solarGroup)

  // ═══ 星云（加法混合大平面 + 时间驱动噪声，2026-08-30 场景升级）═══
  const nebulaMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform float uTime;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float noise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y); }
      void main(){ vec2 p=vUv*3.6; float n=noise(p+vec2(uTime*.016,uTime*.009));
        n=n*.62+noise(p*2.7-uTime*.012)*.38; float d=distance(vUv,vec2(.5,.43));
        float mask=smoothstep(.62,.05,d); vec3 cyan=vec3(.11,.58,.72); vec3 violet=vec3(.36,.18,.76);
        vec3 col=mix(cyan,violet,smoothstep(.28,.68,n)); gl_FragColor=vec4(col,pow(n,2.4)*mask*.36); }`,
  })
  const nebula = new THREE.Mesh(new THREE.PlaneGeometry(58, 30), nebulaMaterial)
  nebula.position.set(0, 7, -19)
  scene.add(nebula)

  // ═══ 后处理：选择性 Bloom——只给宇宙背景发光，机器人本体不参与 ═══
  // 渲染分两步（官方 selective bloom 的图层变体，免去逐帧换材质的开销与破坏性）：
  //   ① bloomComposer：相机临时只看 GLOW 层 → UnrealBloomPass 产出纯背景辉光纹理（不上屏）；
  //   ② finalComposer：相机恢复 → 正常渲染整场景 → mixPass 把辉光纹理加法叠回 → OutputPass 输出。
  const renderScene = new RenderPass(scene, camera)
  // ① 背景辉光通道：默认 HalfFloat 目标即可，辉光是模糊图，不需要 MSAA
  const bloomComposer = new EffectComposer(renderer)
  bloomComposer.renderToScreen = false      // 关键：只产纹理不上屏，最终输出由主通道负责
  bloomComposer.addPass(renderScene)
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    0.9,   // strength：只辉背景，强度可放开（机器人已隔离在 GLOW 层之外）
    0.55,  // radius 辉光扩散半径（0~1）
    0.35,  // threshold：星点/地板环带亮度以上才起辉，深色网格不受影响
  )
  bloomComposer.addPass(bloomPass)
  bloomComposer.addPass(new OutputPass())   // 辉光纹理同样走 tone mapping，与主通道色调一致

  // ② 主通道：4x MSAA 目标保持网格线/圆环边缘质量（后处理接管渲染后默认目标无多重采样）
  const finalRTSize = renderer.getDrawingBufferSize(new THREE.Vector2())
  const finalRT = new THREE.WebGLRenderTarget(finalRTSize.x, finalRTSize.y, {
    type: THREE.HalfFloatType, samples: 4,
  })
  const finalComposer = new EffectComposer(renderer, finalRT)
  finalComposer.addPass(renderScene)
  // mixPass：把辉光纹理加法叠加到整场景。只加 RGB、保留 base 的 alpha——
  // 透明夜空区域的辉光以"发光粉尘"形式浮在 CSS 渐变上（premultiplied 合成），不会把背景涂黑。
  const mixPass = new ShaderPass(new THREE.ShaderMaterial({
    uniforms: {
      baseTexture: { value: null },
      bloomTexture: { value: bloomComposer.renderTarget2.texture },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec2 vUv;
      uniform sampler2D baseTexture; uniform sampler2D bloomTexture;
      void main(){
        vec4 base = texture2D(baseTexture, vUv);
        vec4 bloom = texture2D(bloomTexture, vUv);
        gl_FragColor = vec4(base.rgb + bloom.rgb, base.a);
      }`,
  }), 'baseTexture')
  mixPass.needsSwap = true
  finalComposer.addPass(mixPass)
  finalComposer.addPass(new OutputPass())

  // 场景级暗化缓存：聚焦模式下轨道线/雷达环/小行星带/行星标签降透明度
  let solarDim = 1



  return {
    bloomPass,
    render(camera: THREE.Camera): void {
      // 选择性 Bloom 两步渲染：先只渲染 GLOW 层产辉光纹理，再渲染整场景叠加辉光。
      // mask 保存/恢复，避免影响同一帧内 Raycaster/project 等其它相机用法。
      const camLayerMask = camera.layers.mask
      camera.layers.set(GLOW_LAYER)
      bloomComposer.render()
      camera.layers.mask = camLayerMask
      finalComposer.render()
    },
    update(t: number, dt: number, dim: number): void {
      // 太阳系整体进动极慢（0.006 rad/s ≈ 17 分钟一圈），行星公转/自转用 dt 累加（帧率无关）
      solarGroup.rotation.y = t * 0.006
      for (const pl of planetAnchors) {
        pl.anchor.rotation.y += pl.speed * dt
        pl.mesh.rotation.y += pl.spin * dt
      }
      // 小行星带独立差速：角速度介于火星(0.081)与木星(0.044)之间
      beltPts.rotation.y -= 0.062 * dt
      // 场景级暗化（聚焦模式）：轨道线/雷达环降透明度，行星标签降透明度
      if (dim !== solarDim) {
        solarDim = dim
        orbitLineMat.opacity = 0.38 * solarDim
        ;(radarRing.material as THREE.MeshBasicMaterial).opacity = 0.38 * solarDim
        ;(beltPts.material as THREE.PointsMaterial).opacity = 0.65 * solarDim
        for (const lb of planetLabels) {
          const el = lb.element as HTMLElement
          el.style.opacity = String(0.75 * solarDim)
        }
      }
      stars.rotation.y = t * .012
      haloA.rotation.y = t * .05           // 光环慢速顺时针巡航
      haloB.rotation.y = -t * .033         // 外环反向，制造交错层次
      haloA.position.y = Math.sin(t * .6) * .02
      haloB.position.y = Math.sin(t * .45 + 1.2) * .03
      nebulaMaterial.uniforms.uTime.value = t
    },
    setSize(w: number, h: number): void {
      // 两级后处理链同步缩放（setSize 内部已含 pixelRatio）
      bloomComposer.setSize(w, h)
      finalComposer.setSize(w, h)
    },
    dispose(scene: THREE.Scene): void {
      scene.remove(grid, stars, haloGroup, radarRing, solarGroup, nebula)
      ;[starGeo, beltGeo].forEach(g => g.dispose())
      // 释放 Points 材质（可能为数组，three 类型允许 Material|Material[]，统一展开处理）
      ;[stars.material, haloA.material, haloB.material, beltPts.material,
        orbitLineMat, nebulaMaterial].forEach(m => {
        const mats = Array.isArray(m) ? m : [m]
        mats.forEach(mm => mm.dispose())
      })
      // 太阳系内部网格（行星/环/轨道线）逐一释放
      solarGroup.traverse(o => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh) {
          mesh.geometry.dispose()
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          materials.forEach(m => m.dispose())
        }
      })
    },
  }
}

