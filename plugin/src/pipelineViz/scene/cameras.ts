// 六机位与正交相机几何。移植自演示 scene.js 的 CAMERA_PRESETS / applyProjection /
// setCameraPreset / updateCameraTransition。这里只做纯几何与缓动状态：不碰 DOM/React，
// 容器尺寸由引擎通过 setViewport 喂进来。
import * as THREE from "three";
import { STAGE_X } from "./pipeline-model";

/** 一个机位的完整取景参数。height 是正交视锥高度，width 是最小可视宽度。 */
export interface CameraPreset {
  /** 机位按钮/无障碍标签用的中文名。 */
  readonly label: string;
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly height: number;
  readonly width: number;
}

/** 只声明相机控制实际用到的成员，免得 cameras 模块反向依赖 OrbitControls。 */
export interface CameraControlsLike {
  target: THREE.Vector3;
  update(): boolean;
}

export const CAMERA_TRANSITION_MS = 280;
export const CAMERA_MIN_ZOOM = 0.55;
export const CAMERA_MAX_ZOOM = 3.5;

/**
 * 0 是全景，1-5 逐站聚焦。1-5 的 target.x 直接引用 STAGE_X——设备挪位时，
 * 机位和拾取不会各说各话。
 */
export const CAMERA_PRESETS: readonly CameraPreset[] = [
  {
    label: "全景",
    position: [15, 10, 21],
    target: [0, 1.3, 0],
    height: 11.6,
    width: 22,
  },
  {
    label: "文档准备",
    position: [-4.5, 5.6, 7.4],
    target: [STAGE_X[0], 1.45, 0],
    height: 5.4,
    width: 5.7,
  },
  {
    label: "OCR 识别",
    position: [-0.8, 5.3, 6.6],
    target: [STAGE_X[1], 1.65, 0],
    height: 5.0,
    width: 5.4,
  },
  {
    label: "文本翻译",
    position: [4.4, 5.8, 6.7],
    target: [STAGE_X[2], 1.9, 0],
    height: 5.6,
    width: 6.0,
  },
  {
    label: "版面重建",
    position: [8.6, 6.1, 6.9],
    target: [STAGE_X[3], 1.55, 0],
    height: 5.6,
    width: 6.0,
  },
  {
    label: "完成输出",
    position: [11.4, 5.5, 6.7],
    target: [STAGE_X[4], 1.45, 0],
    height: 5.2,
    width: 5.7,
  },
];

/** 竖屏时全景机位要抬高拉远，否则 22 个单位宽的流水线会被裁掉两端。 */
const PORTRAIT_OVERVIEW: CameraPreset = {
  label: "全景",
  position: [20, 24, 9],
  target: [0, 1.0, 0],
  height: 22,
  width: 10,
};

export function createOrthographicCamera(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-10, 10, 6, -6, 0.1, 240);
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  return camera;
}

/** 按容器宽高比扩展视锥：先保证机位想要的高度，再保证最小可视宽度。 */
export function resolveCameraPreset(
  index: number,
  aspect: number,
): CameraPreset {
  const preset = CAMERA_PRESETS[index];
  if (!preset) return CAMERA_PRESETS[0];
  return index === 0 && aspect < 0.9 ? PORTRAIT_OVERVIEW : preset;
}

export interface CameraControllerOptions {
  /** reduced-motion / capture：机位切换不做 280ms 缓动。 */
  readonly instant?: boolean;
}

export interface CameraController {
  readonly activePreset: number;
  setViewport(aspect: number): void;
  setPreset(index: number, instant?: boolean): void;
  /** 推进缓动，返回这一帧是否仍在过渡中。 */
  update(now: number): boolean;
  zoomBy(factor: number): void;
  cancelTransition(): void;
  applyProjection(): void;
}

interface CameraTransition {
  readonly started: number;
  readonly duration: number;
  readonly fromPosition: THREE.Vector3;
  readonly toPosition: THREE.Vector3;
  readonly fromTarget: THREE.Vector3;
  readonly toTarget: THREE.Vector3;
  readonly fromZoom: number;
  readonly fromHeight: number;
  readonly toHeight: number;
  readonly fromWidth: number;
  readonly toWidth: number;
}

/**
 * 相机导演：把演示里散落在 scene.js 的 currentViewHeight / currentMinWidth /
 * transition / activeCamera 收进闭包。引擎只负责每帧调用 update。
 */
export function createCameraController(
  camera: THREE.OrthographicCamera,
  controls: CameraControlsLike,
  options: CameraControllerOptions = {},
): CameraController {
  let aspect = 1;
  let currentViewHeight = 11.6;
  let currentMinWidth = 22;
  let activePreset = 0;
  let transition: CameraTransition | null = null;

  function applyProjection(): void {
    const safeAspect = Math.max(0.2, aspect);
    // 演示口径：高度不足时按最小宽度反推，保证五站不会被左右裁切。
    const height = Math.max(currentViewHeight, currentMinWidth / safeAspect);
    camera.left = -(height * safeAspect) / 2;
    camera.right = (height * safeAspect) / 2;
    camera.top = height / 2;
    camera.bottom = -height / 2;
    camera.updateProjectionMatrix();
  }

  function cancelTransition(): void {
    transition = null;
  }

  function setViewport(nextAspect: number): void {
    aspect = Math.max(0.2, nextAspect);
    applyProjection();
  }

  function setPreset(index: number, instant = false): void {
    const preset = CAMERA_PRESETS[index];
    if (!preset) return;
    activePreset = index;
    const end = resolveCameraPreset(index, aspect);
    if (instant || options.instant === true) {
      transition = null;
      camera.position.set(...end.position);
      controls.target.set(...end.target);
      camera.zoom = 1;
      currentViewHeight = end.height;
      currentMinWidth = end.width;
      applyProjection();
      controls.update();
      return;
    }
    transition = {
      started: performance.now(),
      duration: CAMERA_TRANSITION_MS,
      fromPosition: camera.position.clone(),
      toPosition: new THREE.Vector3(...end.position),
      fromTarget: controls.target.clone(),
      toTarget: new THREE.Vector3(...end.target),
      fromZoom: camera.zoom,
      fromHeight: currentViewHeight,
      toHeight: end.height,
      fromWidth: currentMinWidth,
      toWidth: end.width,
    };
  }

  function update(now: number): boolean {
    if (!transition) return false;
    const raw = Math.min(1, (now - transition.started) / transition.duration);
    // 与演示一致的三次缓出：起步快、收尾稳，适合"飞过去看设备"。
    const t = 1 - Math.pow(1 - raw, 3);
    camera.position.lerpVectors(
      transition.fromPosition,
      transition.toPosition,
      t,
    );
    controls.target.lerpVectors(transition.fromTarget, transition.toTarget, t);
    camera.zoom = THREE.MathUtils.lerp(transition.fromZoom, 1, t);
    currentViewHeight = THREE.MathUtils.lerp(
      transition.fromHeight,
      transition.toHeight,
      t,
    );
    currentMinWidth = THREE.MathUtils.lerp(
      transition.fromWidth,
      transition.toWidth,
      t,
    );
    applyProjection();
    if (raw >= 1) transition = null;
    return true;
  }

  function zoomBy(factor: number): void {
    transition = null;
    camera.zoom = THREE.MathUtils.clamp(
      camera.zoom * factor,
      CAMERA_MIN_ZOOM,
      CAMERA_MAX_ZOOM,
    );
    camera.updateProjectionMatrix();
  }

  return {
    get activePreset(): number {
      return activePreset;
    },
    setViewport,
    setPreset,
    update,
    zoomBy,
    cancelTransition,
    applyProjection,
  };
}
