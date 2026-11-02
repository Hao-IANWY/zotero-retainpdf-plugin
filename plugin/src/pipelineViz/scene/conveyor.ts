// 传送带：优先加载设计资产库里的真实传送带模型，失败时退回参数化简化传送带。
// 两条路径的外观不同，但结构一致——三节模块沿 X 排开，条板统一实例化，
// 由 sample(t) 逐帧改写实例矩阵，形成循环输送。
//
// 为什么条板要做成 InstancedMesh：每节 26 条条板、三节共 78 个同几何同材质的小盒子，
// 逐个 Mesh 是 78 个 draw call；按「几何 + 材质」分组成实例批次后，每帧只更新矩阵，
// 批次数量由材质数决定。实例矩阵必须标 DynamicDrawUsage，驱动层才知道它每帧都会变。
//
// 插件侧差异：资产工厂（原 asset.mjs/loader.mjs）已移植成 conveyorAsset.ts 直接
// 进 chunk，gz 资源按 chrome://retainpdf/content/pipeline-viz/conveyor/ 静态伺服；
// fetch/DecompressionStream 或资产缺失时 catch 静默回退——传送带只是背景，不能
// 因为它让整个三维视图起不来。

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
// 演示从 models.js 导入台面高度；models.js 按规划拆成了 stations/* 与
// pipeline-model.ts，后者保留了同名重导出，这里跟着换路径即可。
import { BASE_TOP } from "./pipeline-model";
import { createConveyorAsset } from "./conveyorAsset";
import { config } from "../../../package.json";

/** 资产目录：XPI 内的 chrome 资源，不参与打包。 */
const ASSET_BASE: string = `chrome://${config.addonRef}/content/pipeline-viz/conveyor/`;

/** sample(t) 的条板回转长度与推进速度，取演示的传送带几何宽度与线速度。 */
const BELT_SPAN: number = 5.64;
const BELT_SPEED: number = 0.42;
const BELT_MIN_X: number = -2.82;

/**
 * `traverse` 给的是 Object3D，而 @types/three 只在 Mesh 上声明 isMesh，
 * 点不出来；先按结构确认是网格，调用方才好安全使用 geometry。
 */
function isMesh(object: THREE.Object3D): object is THREE.Mesh {
  return (object as { readonly isMesh?: boolean }).isMesh === true;
}

/** 一条可动的条板：相对根的局部矩阵，以及采样时只需要改写的 X 基准值。 */
type BeltItem = {
  baseX: number;
  matrix: THREE.Matrix4;
};

/** 一个实例批次：同几何同材质的全部条板，外加它们各自的基准矩阵。 */
type BeltBatch = {
  mesh: THREE.InstancedMesh;
  items: BeltItem[];
};

/** 传送带工厂的返回值；引擎只依赖 group 与 sample。 */
export type ConveyorBundle = {
  readonly group: THREE.Group;
  readonly sample: (t: number) => void;
  readonly stripCount: number;
};

/**
 * 参数化简化传送带：铝型材侧梁、滚轮、橡胶条板与支腿。
 * 仅在真实资产加载失败时使用，因此不追求细节，但条板命名必须与资产一致
 * （Belt_strip_ 前缀），后面的实例化逻辑两条路径共用。
 */
function fallbackModule(): THREE.Group {
  const root: THREE.Group = new THREE.Group();
  const metal: THREE.MeshStandardMaterial = new THREE.MeshStandardMaterial({
    color: 0xaeb7b5,
    roughness: 0.3,
    metalness: 0.75,
  });
  const rubber: THREE.MeshStandardMaterial = new THREE.MeshStandardMaterial({
    color: 0x263032,
    roughness: 0.88,
  });
  const dark: THREE.MeshStandardMaterial = new THREE.MeshStandardMaterial({
    color: 0x465151,
    roughness: 0.45,
    metalness: 0.5,
  });
  const add = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh => {
    const mesh: THREE.Mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };
  for (const z of [-1.0, 1.0]) {
    add(new RoundedBoxGeometry(6, 0.24, 0.16, 2, 0.04), metal, 0, 0.68, z);
    for (let i = 0; i < 10; i += 1) {
      const bolt: THREE.Mesh = add(
        new THREE.CylinderGeometry(0.035, 0.035, 0.025, 10),
        dark,
        -2.65 + i * 0.59,
        0.69,
        z + Math.sign(z) * 0.09,
      );
      bolt.rotation.x = Math.PI / 2;
    }
  }
  for (const x of [-2.82, 2.82]) {
    const roller: THREE.Mesh = add(
      new THREE.CylinderGeometry(0.2, 0.2, 1.82, 24),
      dark,
      x,
      0.67,
      0,
    );
    roller.rotation.x = Math.PI / 2;
  }
  for (let i = 0; i < 26; i += 1) {
    const slat: THREE.Mesh = add(
      new RoundedBoxGeometry(0.19, 0.055, 1.8, 1, 0.015),
      rubber,
      -2.75 + i * 0.22,
      0.84,
      0,
    );
    slat.name = `Belt_strip_${String(i).padStart(3, "0")}`;
  }
  for (const x of [-2.1, -0.7, 0.7, 2.1]) {
    add(new RoundedBoxGeometry(0.3, 0.58, 1.82, 2, 0.05), metal, x, 0.28, 0);
    for (const z of [-0.8, 0.8])
      add(new THREE.CylinderGeometry(0.11, 0.11, 0.12, 16), rubber, x, 0.02, z);
  }
  return root;
}

/**
 * 把 root 下所有 Belt_strip_ 网格收进 InstancedMesh。
 * 分组键是「几何 uuid:材质 uuid」：真实资产里三节模块共享同一份几何/材质，
 * 因此会并成少数几个批次；简化传送带则是每节一份独立的几何与材质。
 * 矩阵先换算成相对 root 的局部空间（乘 root.matrixWorld 的逆），这样批次挂在
 * root 下仍保持原位，sample 写回时也只改平移分量。
 */
function instanceBeltStrips(root: THREE.Object3D, batches: BeltBatch[]): void {
  root.updateMatrixWorld(true);
  const inverse: THREE.Matrix4 = root.matrixWorld.clone().invert();
  const families: Map<
    string,
    {
      geometry: THREE.BufferGeometry;
      material: THREE.Material;
      objects: THREE.Mesh[];
    }
  > = new Map();
  root.traverse((object: THREE.Object3D): void => {
    if (!isMesh(object) || !object.name.startsWith("Belt_strip_")) return;
    const material: THREE.Material = Array.isArray(object.material)
      ? object.material[0]
      : object.material;
    const key: string = `${object.geometry.uuid}:${material.uuid}`;
    let family:
      | {
          geometry: THREE.BufferGeometry;
          material: THREE.Material;
          objects: THREE.Mesh[];
        }
      | undefined = families.get(key);
    if (!family) {
      family = { geometry: object.geometry, material, objects: [] };
      families.set(key, family);
    }
    family.objects.push(object);
  });
  for (const family of families.values()) {
    const instanced: THREE.InstancedMesh = new THREE.InstancedMesh(
      family.geometry,
      family.material,
      family.objects.length,
    );
    instanced.name = "动态传送带条板批次";
    instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // 条板本身很小，投影出来只有噪点；接收阴影保留，让传送带整体仍压在地面阴影里。
    instanced.castShadow = false;
    instanced.receiveShadow = true;
    const items: BeltItem[] = [];
    family.objects.forEach((object: THREE.Mesh, index: number): void => {
      const matrix: THREE.Matrix4 = new THREE.Matrix4().multiplyMatrices(
        inverse,
        object.matrixWorld,
      );
      instanced.setMatrixAt(index, matrix);
      items.push({ baseX: matrix.elements[12], matrix });
      object.removeFromParent();
    });
    instanced.computeBoundingSphere();
    root.add(instanced);
    batches.push({ mesh: instanced, items });
  }
}

/**
 * 阴影审计：资产里的小螺栓也开了投影，但它们在屏幕上不足一个像素，只会让
 * 阴影贴图白忙。短边小于 0.42 的网格统一关闭投影（演示的阈值）。
 */
function auditShadows(root: THREE.Object3D): void {
  root.traverse((object: THREE.Object3D): void => {
    if (!isMesh(object) || !object.castShadow) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    const bounds: THREE.Box3 | null = object.geometry.boundingBox;
    if (!bounds) return;
    const size: THREE.Vector3 = bounds.getSize(new THREE.Vector3());
    if (Math.max(size.x, size.y, size.z) < 0.42) object.castShadow = false;
  });
}

/**
 * 建三节传送带，返回采样入口。
 * 资产加载、克隆、实例化中的任何异常都在这里吞掉并回退到简化传送带；
 * 实例、批次与采样矩阵都收在本函数闭包里，模块顶层不持有可变状态。
 */
export async function createConveyors(): Promise<ConveyorBundle> {
  const group: THREE.Group = new THREE.Group();
  group.name = "精密传送带组";
  const batches: BeltBatch[] = [];
  try {
    // states 固定 lazy（只构建默认状态），sharedResources 让三节克隆共享几何与贴图。
    const template = await createConveyorAsset(THREE, ASSET_BASE, {
      sharedResources: true,
    });
    template.updateMatrixWorld(true);
    const bounds: THREE.Box3 = new THREE.Box3().setFromObject(template);
    const size: THREE.Vector3 = bounds.getSize(new THREE.Vector3());
    const center: THREE.Vector3 = bounds.getCenter(new THREE.Vector3());
    // 资产按真实米制建模，宽度不一定是演示的三节间距；整体缩放到 6.02 宽。
    const scale: number = 6.02 / size.x;
    // clone 只复制 Object3D 部分（setState/dispose 这类实例方法不会跟过去）；
    // 下面三步只需要变换与子节点能力，按 Group 处理即可。
    const assets: THREE.Group[] = [
      template,
      template.clone(true),
      template.clone(true),
    ];
    for (let i = 0; i < 3; i += 1) {
      const asset: THREE.Group = assets[i];
      const placement: THREE.Group = new THREE.Group();
      placement.name = `传送带模块-${i + 1}`;
      placement.scale.setScalar(scale);
      // Y 抵消资产包围盒的最低点，让传送带底边正好落在台面上；Z 居中。
      placement.position.set(
        (i - 1) * 6.02,
        BASE_TOP - bounds.min.y * scale,
        -center.z * scale,
      );
      placement.add(asset);
      group.add(placement);
      auditShadows(asset);
      instanceBeltStrips(asset, batches);
    }
  } catch {
    // 静默回退：file://、离线、资产被裁剪时都走这里，视觉简化但功能完整。
    for (let i = 0; i < 3; i += 1) {
      const module: THREE.Group = fallbackModule();
      module.position.set((i - 1) * 6.02, BASE_TOP, 0);
      group.add(module);
      instanceBeltStrips(module, batches);
    }
  }
  const stripCount: number = batches.reduce(
    (sum: number, batch: BeltBatch): number => sum + batch.items.length,
    0,
  );
  const temp: THREE.Matrix4 = new THREE.Matrix4();
  /**
   * 逐帧推进条板：t 是场景模拟时间（秒），条板沿 X 以 0.42 单位/秒前进；
   * 越过 5.64 的回转长度后从起点重新进入。两次取模把负时间也折回正区间，
   * 这样暂停/回退时钟不会把条板甩到传送带外面。
   */
  function sample(t: number): void {
    for (const batch of batches) {
      batch.items.forEach((item: BeltItem, index: number): void => {
        temp.copy(item.matrix);
        temp.elements[12] =
          ((((item.baseX - BELT_MIN_X + t * BELT_SPEED) % BELT_SPAN) +
            BELT_SPAN) %
            BELT_SPAN) +
          BELT_MIN_X;
        batch.mesh.setMatrixAt(index, temp);
      });
      batch.mesh.instanceMatrix.needsUpdate = true;
    }
  }
  return { group, sample, stripCount };
}
