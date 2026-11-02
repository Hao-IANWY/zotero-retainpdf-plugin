// 纸张模型：一张薄盒 + 正面贴图，流水线上所有“一页纸”都复用它。
//
// 为什么把材质当参数传进来：纸张材质由 createPipelineMaterials() 统一持有，
// 本模块在模块顶层不创建任何 THREE 对象（全局单例门禁），这样每次建场景都拿到
// 一套新材质，销毁后不会留下跨实例的引用。
// 为什么用两个 Mesh 而不是给盒子贴图：盒子六个面都贴图会让纸张侧边出现拉伸的
// 文字；单独一张略微抬高的平面只覆盖正面，侧面保持干净的纸色。

import * as THREE from "three";
import type { PipelineMaterials } from "./materials";

/**
 * 造一张纸。
 * @param texture 正面的文档贴图；传 null 时只保留纸色薄盒（纸堆中间那几十张
 *   不单独贴图，省显存）。
 */
export function paperMesh(
  materials: PipelineMaterials,
  texture: THREE.Texture | null,
  width: number = 1.12,
  depth: number = 1.44,
): THREE.Group {
  const page = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.016, depth),
    materials.paper,
  );
  base.receiveShadow = true;
  base.castShadow = false;
  page.add(base);

  if (texture) {
    const topMaterial = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.88,
      metalness: 0,
    });
    const print = new THREE.Mesh(
      new THREE.PlaneGeometry(width * 0.985, depth * 0.985),
      topMaterial,
    );
    // 平面默认竖直朝 +Z，转成水平朝上，再抬高到薄盒上表面之上避免 z-fighting。
    print.rotation.x = -Math.PI / 2;
    print.position.y = 0.0086;
    print.receiveShadow = true;
    page.add(print);
  }

  return page;
}
