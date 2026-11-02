// 流水线设备的共享材质，以及静态网格按材质合批。
//
// 为什么材质不放在模块顶层：scene/ 下的模块会被懒加载 chunk 静态引用，门禁禁止
// 模块级可变状态；而且材质属于某一次模型实例，收进 createPipelineMaterials() 的
// 返回对象里，才能随整个 group 一起销毁、重建（WebGL 上下文丢失后的重建路径）。
//
// 为什么合批：五台设备加起来有上百个同材质的螺栓、栅条、外壳小件，逐个 draw call
// 在低端机上会拖垮帧率。按材质把静态网格的几何合并成一个 Mesh 后，draw call 数量
// 从“零件数”降到“材质数”，而视觉完全不变。

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** 演示里的设备配色；只读字面量，模块顶层不允许创建 THREE 对象。 */
const COLORS = Object.freeze({
  porcelain: 0xe9ece9,
  porcelainTop: 0xf4f5f2,
  aluminum: 0xaeb7b5,
  darkMetal: 0x3d4949,
  graphite: 0x1d282a,
  rubber: 0x263032,
  paper: 0xf6f5ef,
  teal: 0x4f9f8e,
  brass: 0xb99764,
});

/** 五台设备共用的一套材质，每个模型实例独有一份。 */
export interface PipelineMaterials {
  porcelain: THREE.MeshStandardMaterial;
  top: THREE.MeshStandardMaterial;
  aluminum: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  graphite: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  paper: THREE.MeshStandardMaterial;
  brass: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  teal: THREE.MeshStandardMaterial;
}

/** 演示里 mat() 的等价物：统一粗糙度/金属度默认值，个别材质再补额外参数。 */
function standardMaterial(
  color: number,
  roughness: number = 0.55,
  metalness: number = 0.05,
  extra: THREE.MeshStandardMaterialParameters = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    ...extra,
  });
}

/**
 * 创建一套新材质。
 * 每次 build 都新建而不复用模块级单例：材质被材质合批按 uuid 分组，跨实例复用会
 * 把两个场景的几何错误地并到一起，销毁时也会互相影响。
 */
export function createPipelineMaterials(): PipelineMaterials {
  return {
    porcelain: standardMaterial(COLORS.porcelain, 0.3, 0.16),
    top: standardMaterial(COLORS.porcelainTop, 0.4, 0.08),
    aluminum: standardMaterial(COLORS.aluminum, 0.25, 0.78),
    dark: standardMaterial(COLORS.darkMetal, 0.32, 0.68),
    graphite: standardMaterial(COLORS.graphite, 0.45, 0.35),
    rubber: standardMaterial(COLORS.rubber, 0.88, 0.02),
    paper: standardMaterial(COLORS.paper, 0.84, 0),
    brass: standardMaterial(COLORS.brass, 0.3, 0.72),
    // 玻璃要透光：降低不透明度并关掉深度写入，避免挡住后面的机架细节。
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xb9d4cf,
      roughness: 0.12,
      metalness: 0,
      transparent: true,
      opacity: 0.2,
      transmission: 0.25,
      depthWrite: false,
    }),
    teal: standardMaterial(COLORS.teal, 0.28, 0.25, {
      emissive: COLORS.teal,
      emissiveIntensity: 0.4,
    }),
  };
}

/**
 * 把一个站台根节点下的静态网格按材质合并。
 *
 * `dynamicRoots` 里的子树（进纸纸、扫描条、龙门、指示灯、输出纸堆、站台垫子）
 * 会随 sample() 改变位置或材质，必须原样保留；透明材质（玻璃、屏幕、站牌）
 * 留在各自的 draw call 里，避免合并后排序出错。
 *
 * 几何在合并前先变换到根节点局部空间，这样合并后的 Mesh 直接挂在 root 下即可；
 * 被合并掉的源 Mesh 会从父节点摘除，它们的几何是克隆体，合并后立即释放。
 */
export function mergeStaticStage(
  root: THREE.Group,
  dynamicRoots: ReadonlySet<THREE.Object3D>,
): void {
  root.updateMatrixWorld(true);
  const inverse: THREE.Matrix4 = root.matrixWorld.clone().invert();
  const buckets: Map<string, THREE.Mesh[]> = new Map<string, THREE.Mesh[]>();

  const isDynamic = (object: THREE.Object3D): boolean => {
    let current: THREE.Object3D | null = object;
    while (current && current !== root) {
      if (dynamicRoots.has(current)) return true;
      current = current.parent;
    }
    return false;
  };

  root.traverse((object: THREE.Object3D): void => {
    if (!(object instanceof THREE.Mesh)) return;
    const material: THREE.Material | THREE.Material[] = object.material;
    // 透明物体参与合并会破坏 three 的透明排序，单独留着。
    if (isDynamic(object) || Array.isArray(material) || material.transparent)
      return;
    const key: string = material.uuid;
    const bucket: THREE.Mesh[] | undefined = buckets.get(key);
    if (bucket) {
      bucket.push(object);
    } else {
      buckets.set(key, [object]);
    }
  });

  for (const [materialId, objects] of buckets.entries()) {
    // 只有一个零件的材质没有合并收益，反而多一次几何拷贝。
    if (objects.length < 2) continue;

    const geometries: THREE.BufferGeometry[] = objects.map(
      (object: THREE.Mesh): THREE.BufferGeometry => {
        let geometry: THREE.BufferGeometry = object.geometry.clone();
        // mergeGeometries 要求所有输入同为索引/非索引；统一转成非索引。
        if (geometry.index) {
          const indexed: THREE.BufferGeometry = geometry;
          geometry = indexed.toNonIndexed();
          indexed.dispose();
        }
        const relative: THREE.Matrix4 = new THREE.Matrix4().multiplyMatrices(
          inverse,
          object.matrixWorld,
        );
        geometry.applyMatrix4(relative);
        return geometry;
      },
    );

    const combined: THREE.BufferGeometry | null = mergeGeometries(
      geometries,
      false,
    );
    geometries.forEach((geometry: THREE.BufferGeometry): void =>
      geometry.dispose(),
    );
    if (!combined) continue;

    combined.computeBoundingBox();
    combined.computeBoundingSphere();
    const merged = new THREE.Mesh(combined, objects[0].material);
    merged.name = `static-batch-${materialId.slice(0, 6)}`;
    // 只要原零件里有一个投射阴影，合并体就投射；接收阴影统一打开。
    merged.castShadow = objects.some(
      (object: THREE.Mesh): boolean => object.castShadow,
    );
    merged.receiveShadow = true;
    root.add(merged);
    objects.forEach((object: THREE.Mesh): void => {
      object.removeFromParent();
    });
  }
}
