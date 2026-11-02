// 场景引擎：把演示 scene.js 的渲染器、灯光、地面、按需渲染循环和拾取收进一个
// 工厂闭包。演示里 23 个模块顶层 let 在这里全部变成闭包状态——模块顶层只留类型
// 与常量，既过仓库的全局单例门禁，也让宿主可以随时 dispose 重建。
//
// 插件侧运行环境：本模块只经懒 chunk（retainpdf-pipeline.js）加载进【中控台
// 窗口】作用域，document/window 由该注入环境提供——主 bundle 的 tsconfig
// （zotero-types sandbox）没有 DOM 全局，这里显式声明运行期存在。
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { createPipelineModel, TOTAL_DURATION } from "./pipeline-model";
import { createConveyors } from "./conveyor";
import { createCameraController, createOrthographicCamera } from "./cameras";

declare const document: Document;
declare const window: Window;

/** 宿主喂进来的场景状态；failedIndex 为 null 表示没有失败站。 */
export interface PipelineSceneInput {
  stageIndex: number;
  stageProgress: number;
  overall: number;
  complete: boolean;
  motion: number; // 1 正常动画，0 静止（reduced-motion）。
  failedIndex: number | null;
}

export interface EngineOptions {
  reducedMotion?: boolean; // 不传时读 matchMedia；宿主可显式覆盖，便于测试与视觉回归。
  capture?: boolean; // ?capture：不启动连续循环，由 renderSingleFrame 渲染。
  onReady?: () => void; // 传送带就位（或资产回退完成）后调用。
  onContextLost?: () => void; // WebGL 上下文丢失；不自动恢复，宿主降级。
}

export interface PipelineSceneEngine {
  update(input: PipelineSceneInput): void;
  setCamera(index: number, instant?: boolean): void;
  zoomBy(delta: number): void;
  setAutoRotate(on: boolean): void;
  /** 暂停/恢复引擎内部时钟：只停动画，不停止 OrbitControls 与快照更新。 */
  setAnimationPaused(paused: boolean): void;
  reset(): void;
  pickStation(clientX: number, clientY: number): number | null;
  /** 停掉连续循环并同步渲染一帧（capture 模式用）。 */
  renderSingleFrame(view?: number): void;
  /** 传送带就位后回调；已就绪则同步执行。 */
  whenReady(callback: () => void): void;
  dispose(): void;
}

// 只声明引擎实际用到的成员，移植后的模型/传送带可以自由扩字段。
interface PipelineModelHandle {
  group: THREE.Group;
  sample: (time: number, state: PipelineSceneInput) => void;
}
interface ConveyorHandle {
  group: THREE.Group;
  sample: (time: number) => void;
}

const SIMULATION_STEP = 1 / 60;
const MAX_FRAME_DT = 0.08;
const SHADOW_UPDATE_FRAMES = 45;
const BACKGROUND = 0xe9ede9;
/** zoomBy 的 ±1 对应演示里 ×1.18 / ÷1.18 的一档。 */
const ZOOM_STEP = 0.18;

/** 接触阴影用程序化径向渐变贴图，避免为一块软阴影引入图片请求。 */
function createContactShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  // Zotero 沙箱类型把 getContext 的返回声明成 nsISupports，运行期是标准 2D 上下文。
  const context = canvas.getContext(
    "2d",
  ) as unknown as CanvasRenderingContext2D | null;
  if (context) {
    const gradient = context.createRadialGradient(128, 64, 8, 128, 64, 124);
    gradient.addColorStop(0, "rgba(38,48,47,0.28)");
    gradient.addColorStop(0.55, "rgba(38,48,47,0.12)");
    gradient.addColorStop(1, "rgba(38,48,47,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 128);
  }
  return new THREE.CanvasTexture(canvas);
}
function addEnvironment(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
): THREE.WebGLRenderTarget {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const target = pmrem.fromScene(room, 0.04);
  scene.environment = target.texture;
  scene.environmentIntensity = 0.72;
  room.dispose();
  pmrem.dispose();
  return target;
}
function addLights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xf8fbf4, 0x95a39d, 1.08));
  const key = new THREE.DirectionalLight(0xfff1dc, 2.8);
  key.position.set(-10, 18, 12);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -16;
  key.shadow.camera.right = 16;
  key.shadow.camera.top = 12;
  key.shadow.camera.bottom = -12;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 55;
  key.shadow.normalBias = 0.035;
  key.shadow.bias = -0.00015;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xd7e8ef, 0.78);
  fill.position.set(12, 9, -10);
  scene.add(fill);
  // 从地面反打一盏很弱的补光，避免设备底部死黑。
  const bounce = new THREE.DirectionalLight(0xe7f0e9, 0.25);
  bounce.position.set(0, -4, 6);
  scene.add(bounce);
}

function addGroundAndBackdrop(scene: THREE.Scene): void {
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0xe3e8e4,
    roughness: 0.96,
    metalness: 0,
  });
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(220, 80),
    groundMaterial,
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.11;
  ground.receiveShadow = true;
  scene.add(ground);
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: createContactShadowTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.72,
  });
  const contactShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 8),
    shadowMaterial,
  );
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.position.y = -0.104;
  scene.add(contactShadow);
  // 远景体块只负责环境尺度与雾的层次，纯装饰、不投影。
  const farMaterial = new THREE.MeshStandardMaterial({
    color: 0xdde4df,
    roughness: 1,
  });
  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * Math.PI * 2;
    const height = 4 + (i % 4) * 1.8;
    const mass = new THREE.Mesh(
      new THREE.BoxGeometry(8, height, 8),
      farMaterial,
    );
    mass.position.set(
      Math.cos(angle) * 52,
      height / 2 - 0.1,
      Math.sin(angle) * 52,
    );
    mass.rotation.y = angle;
    scene.add(mass);
  }
}

/** 场景销毁时统一回收几何、材质和材质引用的贴图。 */
function disposeSceneResources(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials: THREE.Material[] = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of materials) {
      const record = material as unknown as Record<string, unknown>;
      for (const value of Object.values(record)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}

export function createPipelineSceneEngine(
  container: HTMLElement,
  opts: EngineOptions = {},
): PipelineSceneEngine {
  const reducedMotion =
    opts.reducedMotion ??
    window.matchMedia("(prefers-reduced-motion: reduce)")?.matches === true;
  const capture = opts.capture === true;
  // capture 时也不推进动画时间，保证同参数下每次截图完全一致。
  const timeAdvances = !reducedMotion && !capture;

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: capture,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 1.5));
  const initialWidth = Math.max(1, container.clientWidth);
  const initialHeight = Math.max(1, container.clientHeight);
  renderer.setSize(initialWidth, initialHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute(
    "aria-label",
    "三维流水线：拖动旋转，右键平移，滚轮缩放，也可使用机位按钮",
  );
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.fog = new THREE.Fog(BACKGROUND, 42, 110);
  const camera = createOrthographicCamera();
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = !capture;
  controls.dampingFactor = 0.075;
  controls.screenSpacePanning = true;
  controls.minZoom = 0.55;
  controls.maxZoom = 3.5;
  controls.minPolarAngle = 0.16;
  controls.maxPolarAngle = Math.PI * 0.475;
  controls.autoRotateSpeed = 0.65;
  const cameraController = createCameraController(camera, controls);
  const environmentTarget = addEnvironment(scene, renderer);
  addLights(scene);
  addGroundAndBackdrop(scene);
  const model = createPipelineModel() as unknown as PipelineModelHandle;
  scene.add(model.group);

  let conveyors: ConveyorHandle | null = null;
  let disposed = false;
  let ready = false;
  let loopRunning = false;
  let autoRotate = false;
  let needsRender = true;
  let animationPaused = false;
  let simT = 0;
  let accumulator = 0;
  let frameCount = 0;
  let latestInput: PipelineSceneInput = {
    stageIndex: 0,
    stageProgress: 0,
    overall: 0,
    complete: false,
    motion: reducedMotion ? 0 : 1,
    failedIndex: null,
  };
  const readyCallbacks: Array<() => void> = [];
  const clock = new THREE.Clock();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  controls.addEventListener("start", () => cameraController.cancelTransition());
  controls.addEventListener("change", () => {
    needsRender = true;
  });
  const resizeObserver = new ResizeObserver(() => {
    if (disposed) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height);
    cameraController.setViewport(width / height);
    needsRender = true;
    if (capture) renderFrame();
  });
  resizeObserver.observe(container);

  function handleContextLost(event: Event): void {
    // 不尝试恢复：上下文丢失后重建整套资源更可靠，交给宿主降级。
    event.preventDefault();
    renderer.setAnimationLoop(null);
    loopRunning = false;
    opts.onContextLost?.();
  }
  renderer.domElement.addEventListener("webglcontextlost", handleContextLost);

  function renderFrame(): void {
    if (disposed) return;
    model.sample(simT, latestInput);
    conveyors?.sample(simT);
    renderer.render(scene, camera);
    needsRender = false;
  }

  function frame(now: number): void {
    const dt = Math.min(clock.getDelta(), MAX_FRAME_DT);
    // motion 由宿主快照给出，系统偏好中途变化时也能立刻停/恢复环境动画。
    const animating =
      timeAdvances && !animationPaused && latestInput.motion > 0;
    if (animating) {
      // 固定 1/60 步进 + 按总时长取模：动画速度不漂，也避免模型把连续时钟误判成完成。
      accumulator += dt;
      while (accumulator >= SIMULATION_STEP) {
        simT = (simT + SIMULATION_STEP) % TOTAL_DURATION;
        accumulator -= SIMULATION_STEP;
      }
    }
    const transitioning = cameraController.update(now);
    const controlsChanged = controls.update();
    if (
      animating ||
      transitioning ||
      autoRotate ||
      controlsChanged ||
      needsRender ||
      frameCount === 0
    ) {
      frameCount += 1;
      if (frameCount % SHADOW_UPDATE_FRAMES === 0)
        renderer.shadowMap.needsUpdate = true;
      renderFrame();
    }
  }

  function startLoop(): void {
    if (loopRunning || capture || disposed) return;
    loopRunning = true;
    clock.getDelta();
    renderer.setAnimationLoop(frame);
  }

  function update(input: PipelineSceneInput): void {
    latestInput = input;
    needsRender = true;
  }
  function setCamera(index: number, instant = false): void {
    autoRotate = false;
    controls.autoRotate = false;
    cameraController.setPreset(index, instant || latestInput.motion <= 0);
    needsRender = true;
  }
  function zoomBy(delta: number): void {
    cameraController.zoomBy(1 + delta * ZOOM_STEP);
    needsRender = true;
  }
  function setAutoRotate(on: boolean): void {
    autoRotate = on;
    controls.autoRotate = on;
    needsRender = true;
  }
  function setAnimationPaused(paused: boolean): void {
    animationPaused = paused;
    accumulator = 0;
    needsRender = true;
  }
  function reset(): void {
    setCamera(0);
  }

  function pickStation(clientX: number, clientY: number): number | null {
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    for (const hit of raycaster.intersectObject(model.group, true)) {
      const stageIndex: unknown = hit.object.userData.stageIndex;
      if (typeof stageIndex === "number" && Number.isFinite(stageIndex))
        return stageIndex;
    }
    return null;
  }

  function renderSingleFrame(view?: number): void {
    if (disposed) return;
    if (loopRunning) {
      renderer.setAnimationLoop(null);
      loopRunning = false;
    }
    if (typeof view === "number") setCamera(view, true);
    controls.update();
    renderFrame();
  }

  function whenReady(callback: () => void): void {
    if (disposed) return;
    if (ready) callback();
    else readyCallbacks.push(callback);
  }
  function notifyReady(): void {
    if (ready || disposed) return;
    ready = true;
    opts.onReady?.();
    const callbacks = readyCallbacks.splice(0, readyCallbacks.length);
    for (const callback of callbacks) callback();
  }

  function loadConveyors(): void {
    // Promise.resolve().then 同时兜住同步返回与 async 两种移植形态。
    Promise.resolve()
      .then(() => createConveyors())
      .then((loaded) => {
        if (disposed) return;
        const handle = loaded as unknown as ConveyorHandle;
        conveyors = handle;
        scene.add(handle.group);
        needsRender = true;
        notifyReady();
        if (capture) renderFrame();
      })
      .catch(() => {
        // 传送带模块内部已有参数化回退；模块整体加载失败时也必须放行宿主，
        // 否则 onReady 与 __SCENE_READY__ 永远等不到。
        notifyReady();
      });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    renderer.setAnimationLoop(null);
    loopRunning = false;
    readyCallbacks.length = 0;
    resizeObserver.disconnect();
    renderer.domElement.removeEventListener(
      "webglcontextlost",
      handleContextLost,
    );
    controls.dispose();
    disposeSceneResources(scene);
    environmentTarget.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    container.replaceChildren();
  }

  cameraController.setViewport(initialWidth / initialHeight);
  cameraController.setPreset(0, true);
  loadConveyors();
  if (capture) renderFrame();
  else startLoop();

  return {
    update,
    setCamera,
    zoomBy,
    setAutoRotate,
    setAnimationPaused,
    reset,
    pickStation,
    renderSingleFrame,
    whenReady,
    dispose,
  };
}
