// 五台设备的公共建模件：几何快捷函数、站台垫子、屏幕、站牌、线缆。
//
// 为什么集中在这里：五台设备都要螺栓、脚垫、散热栅、垫子和指示灯，复制五份会
// 让坐标与材质失去单一来源；抽出来也让 stations/*.ts 各自留在 380 行棘轮以内。
//
// 这个文件在模块顶层只放数值常量与冻结数组；所有 THREE 对象都在函数调用期创建，
// scene/ 模块被静态 import 时不会产生任何副作用。

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { createLabelTexture, createScreenTexture } from "../textures";
import type { PipelineMaterials } from "../materials";

/** 五站的 X 坐标；pipeline-model 会原样再导出给引擎。 */
export const STAGE_X: readonly number[] = Object.freeze([
  -7.5, -3.75, 0, 3.75, 7.5,
]);
/** 站台垫子上表面的高度，垫子与指示灯都按它定位。 */
export const BASE_TOP: number = 0.36;
/** 传送带（移动纸张）的中心高度。 */
export const BELT_Y: number = 1.25;

/** 圆柱/螺栓的轴向，和演示里的 'x' | 'y' | 'z' 一致。 */
export type Axis = "x" | "y" | "z";

/** 站台垫子：地面指示块 + 一颗状态灯，sample() 通过它们表达 idle/active/done/failed。 */
export interface StagePad {
  pad: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  indicator: THREE.Mesh;
  indicatorMat: THREE.MeshStandardMaterial;
  index: number;
}

/** 每台设备至少包含根节点与垫子，sample() 的公共部分只依赖这两样。 */
export interface StageBase {
  root: THREE.Group;
  pad: StagePad;
}

/**
 * 建一个 Mesh 并挂到父节点。
 * 默认投射/接收阴影；屏幕、站牌、玻璃等平面传 shadow=false，避免它们参与
 * 阴影渲染后出现黑边或额外开销。
 */
export function mesh<
  TGeometry extends THREE.BufferGeometry,
  TMaterial extends THREE.Material,
>(
  geometry: TGeometry,
  material: TMaterial,
  parent: THREE.Object3D,
  x: number = 0,
  y: number = 0,
  z: number = 0,
  shadow: boolean = true,
): THREE.Mesh<TGeometry, TMaterial> {
  const object = new THREE.Mesh(geometry, material);
  object.position.set(x, y, z);
  object.castShadow = shadow;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

/**
 * 圆角盒。半径自动限制在三个尺寸的 22% 以内，避免薄板传了过大半径后几何翻面。
 */
export function rb<TMaterial extends THREE.Material>(
  parent: THREE.Object3D,
  width: number,
  height: number,
  depth: number,
  material: TMaterial,
  x: number = 0,
  y: number = 0,
  z: number = 0,
  radius: number = 0.05,
): THREE.Mesh<RoundedBoxGeometry, TMaterial> {
  const safeRadius: number = Math.min(
    radius,
    width * 0.22,
    height * 0.22,
    depth * 0.22,
  );
  return mesh(
    new RoundedBoxGeometry(width, height, depth, 3, safeRadius),
    material,
    parent,
    x,
    y,
    z,
  );
}

/** 圆柱，默认沿 Y 轴；'x'/'z' 时旋转 90 度。 */
export function cyl<TMaterial extends THREE.Material>(
  parent: THREE.Object3D,
  radius: number,
  length: number,
  material: TMaterial,
  x: number,
  y: number,
  z: number,
  axis: Axis = "y",
  segments: number = 24,
): THREE.Mesh<THREE.CylinderGeometry, TMaterial> {
  const object = mesh(
    new THREE.CylinderGeometry(radius, radius, length, segments),
    material,
    parent,
    x,
    y,
    z,
  );
  if (axis === "x") object.rotation.z = Math.PI / 2;
  if (axis === "z") object.rotation.x = Math.PI / 2;
  return object;
}

/** 圆环；horizontal=true 时摊平（用作风扇外圈、扫描头镜圈）。 */
export function torus<TMaterial extends THREE.Material>(
  parent: THREE.Object3D,
  radius: number,
  tube: number,
  material: TMaterial,
  x: number,
  y: number,
  z: number,
  horizontal: boolean = false,
): THREE.Mesh<THREE.TorusGeometry, TMaterial> {
  const object = mesh(
    new THREE.TorusGeometry(radius, tube, 10, 32),
    material,
    parent,
    x,
    y,
    z,
  );
  if (horizontal) object.rotation.x = Math.PI / 2;
  return object;
}

/** 螺栓头：小圆柱，不参与阴影（太小，投射阴影只增加开销）。 */
export function bolt(
  parent: THREE.Object3D,
  materials: PipelineMaterials,
  x: number,
  y: number,
  z: number,
  axis: Axis = "z",
  scale: number = 1,
): THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial> {
  const object = cyl(
    parent,
    0.045 * scale,
    0.025 * scale,
    materials.dark,
    x,
    y,
    z,
    axis,
    12,
  );
  object.castShadow = false;
  return object;
}

/** 四个橡胶脚垫 + 铝色支脚，绕设备四角布置。 */
export function feet(
  parent: THREE.Object3D,
  materials: PipelineMaterials,
  width: number,
  depth: number,
  y: number = 0.48,
): void {
  for (const x of [-width / 2, width / 2]) {
    for (const z of [-depth / 2, depth / 2]) {
      cyl(parent, 0.12, 0.22, materials.rubber, x, y, z);
      cyl(parent, 0.07, 0.12, materials.aluminum, x, y + 0.14, z);
    }
  }
}

/** 一排散热栅条；vertical=true 时竖排（侧板散热孔）。 */
export function ventBank(
  parent: THREE.Object3D,
  materials: PipelineMaterials,
  x: number,
  y: number,
  z: number,
  count: number = 7,
  vertical: boolean = false,
): void {
  for (let i: number = 0; i < count; i += 1) {
    const offset: number = (i - (count - 1) / 2) * 0.105;
    const vent = rb(
      parent,
      vertical ? 0.04 : 0.055,
      vertical ? 0.42 : 0.38,
      0.025,
      materials.graphite,
      x + (vertical ? 0 : offset),
      y + (vertical ? offset : 0),
      z,
      0.012,
    );
    vent.castShadow = false;
  }
}

/**
 * 设备屏幕：石墨色边框 + 自发光贴图平面。
 * 贴图在 textures.ts 里现画；标题和副标题由各站传入，调用方可以通过
 * createPipelineModel 的 screenTexts 换掉默认文案（真实模型名/页码）。
 */
export function screen(
  parent: THREE.Object3D,
  materials: PipelineMaterials,
  title: string,
  subtitle: string,
  x: number,
  y: number,
  z: number,
  width: number = 0.8,
  height: number = 0.4,
): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> {
  rb(
    parent,
    width + 0.1,
    height + 0.1,
    0.08,
    materials.graphite,
    x,
    y,
    z,
    0.04,
  );
  const texture: THREE.CanvasTexture = createScreenTexture(title, subtitle);
  const screenMaterial = new THREE.MeshStandardMaterial({
    map: texture,
    // 同一张贴图同时当自发光图：屏幕在暗处也能亮，且不额外吃一张纹理。
    emissiveMap: texture,
    emissive: 0xffffff,
    emissiveIntensity: 0.35,
    roughness: 0.4,
  });
  return mesh(
    new THREE.PlaneGeometry(width, height),
    screenMaterial,
    parent,
    x,
    y,
    z + 0.046,
    false,
  );
}

/** 站牌：透明背景的圆角牌，贴在设备正面。 */
export function label(
  parent: THREE.Object3D,
  code: string,
  text: string,
  x: number,
  y: number,
  z: number,
  width: number = 0.92,
  height: number = 0.26,
): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> {
  const texture: THREE.CanvasTexture = createLabelTexture(code, text);
  const labelMaterial = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    roughness: 0.7,
    // 牌子和设备表面几乎共面，用多边形偏移压住深度冲突。
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  return mesh(
    new THREE.PlaneGeometry(width, height),
    labelMaterial,
    parent,
    x,
    y,
    z,
    false,
  );
}

/** 线缆：Catmull-Rom 曲线扫出的管，连接机架与后方。 */
export function cable(
  parent: THREE.Object3D,
  materials: PipelineMaterials,
  points: ReadonlyArray<readonly [number, number, number]>,
  radius: number = 0.035,
  material: THREE.Material = materials.graphite,
): THREE.Mesh<THREE.TubeGeometry, THREE.Material> {
  const curve = new THREE.CatmullRomCurve3(
    points.map(
      (point: readonly [number, number, number]): THREE.Vector3 =>
        new THREE.Vector3(point[0], point[1], point[2]),
    ),
  );
  return mesh(
    new THREE.TubeGeometry(curve, 32, radius, 8, false),
    material,
    parent,
  );
}

/** 站台根节点：按 STAGE_X 摆放，userData.stageIndex 供点击拾取与合批标记使用。 */
export function stageRoot(index: number): THREE.Group {
  const root = new THREE.Group();
  root.name = `stage-${index}`;
  root.position.x = STAGE_X[index];
  root.userData.stageIndex = index;
  return root;
}

/**
 * 站台垫子与指示灯。
 * 垫子材质和指示灯材质单独返回：sample() 需要直接改它们的 color/emissive，
 * 所以它们也是合批时被排除的“动态根”。
 */
export function addStagePad(root: THREE.Group, index: number): StagePad {
  const material = new THREE.MeshStandardMaterial({
    color: 0xdde2de,
    roughness: 0.72,
    metalness: 0.03,
    emissive: 0x4f9f8e,
    emissiveIntensity: 0,
  });
  const pad = rb(root, 3.35, 0.07, 3.7, material, 0, BASE_TOP + 0.02, 0, 0.06);
  pad.castShadow = false;

  const indicatorMat = new THREE.MeshStandardMaterial({
    color: 0x87918d,
    roughness: 0.3,
    metalness: 0.15,
    emissive: 0x87918d,
    emissiveIntensity: 0.3,
  });
  const indicator = cyl(
    root,
    0.075,
    0.06,
    indicatorMat,
    1.35,
    0.83,
    1.42,
    "z",
    20,
  );
  return { pad, material, indicator, indicatorMat, index };
}
