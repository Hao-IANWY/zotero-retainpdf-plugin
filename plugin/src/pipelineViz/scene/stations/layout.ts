// 站 3：版面重建（layout）。
//
// 建模成一台龙门式打印/重构设备：横梁（gantry）沿 X 来回走，打印头（head）
// 挂在横梁上沿 Z 扫描，喷嘴悬在待重建的页面上方。sample() 用两条不同频率的
// 正弦分别驱动这两个自由度，看起来像在逐行重排版面。

import * as THREE from "three";
import { createDocumentTexture } from "../textures";
import type { PipelineMaterials } from "../materials";
import { paperMesh } from "../paper";
import {
  addStagePad,
  bolt,
  cyl,
  feet,
  label,
  mesh,
  rb,
  screen,
  stageRoot,
  torus,
} from "./shared";
import type { StageBase, StagePad } from "./shared";

export interface LayoutStation extends StageBase {
  /** 龙门横梁，sample() 沿 X 移动。 */
  gantry: THREE.Group;
  /** 打印头，sample() 沿 Z 移动。 */
  head: THREE.Group;
  /** 喷嘴（静态，随 head 一起动）。 */
  nozzle: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
}

export function buildLayout(
  materials: PipelineMaterials,
  screenText?: string,
): LayoutStation {
  const root: THREE.Group = stageRoot(3);
  const pad: StagePad = addStagePad(root, 3);

  feet(root, materials, 2.85, 2.35);
  rb(root, 3.0, 0.3, 2.5, materials.porcelain, 0, 0.72, 0, 0.08);
  rb(root, 2.9, 0.18, 2.22, materials.dark, 0, 1.38, 0, 0.04);
  rb(root, 2.74, 0.08, 2.05, materials.aluminum, 0, 1.5, 0, 0.025);

  // 台面上摊开的待重建页面，略微偏转，避免完全正对镜头显得死板。
  const page: THREE.Group = paperMesh(
    materials,
    createDocumentTexture(2),
    1.34,
    1.65,
  );
  page.position.set(0.25, 1.56, 0);
  page.rotation.y = -0.05;
  root.add(page);

  // 两条纵向导轨 + 四根立柱。
  for (const z of [-1.14, 1.14]) {
    cyl(root, 0.07, 2.9, materials.dark, 0, 2.24, z, "x");
    cyl(root, 0.035, 2.9, materials.aluminum, 0, 2.37, z, "x");
    rb(root, 0.28, 1.25, 0.3, materials.porcelain, -1.3, 1.83, z, 0.06);
    rb(root, 0.28, 1.25, 0.3, materials.porcelain, 1.3, 1.83, z, 0.06);
  }

  // 龙门横梁：整组一起沿 X 移动。
  const gantry = new THREE.Group();
  root.add(gantry);
  rb(gantry, 0.38, 0.32, 2.65, materials.porcelain, 0, 2.67, 0, 0.07);
  rb(gantry, 0.18, 0.14, 2.35, materials.dark, 0, 2.45, 0, 0.03);
  for (const z of [-1.13, 1.13]) {
    rb(gantry, 0.42, 0.54, 0.38, materials.porcelain, 0, 2.27, z, 0.06);
    cyl(gantry, 0.13, 0.26, materials.dark, 0, 2.75, z, "z");
  }

  // 打印头挂在横梁下，沿 Z 移动。
  const head = new THREE.Group();
  gantry.add(head);
  rb(head, 0.54, 0.6, 0.5, materials.graphite, 0, 2.25, 0, 0.07);
  rb(head, 0.4, 0.16, 0.38, materials.aluminum, 0, 1.9, 0, 0.04);
  cyl(head, 0.07, 0.25, materials.brass, 0, 1.73, 0);
  const nozzle = mesh(
    new THREE.CylinderGeometry(0.025, 0.07, 0.12, 20),
    materials.brass,
    head,
    0,
    1.57,
    0,
  );
  torus(head, 0.13, 0.025, materials.teal, 0, 2.02, 0, true);

  // 后方的散热鳍片排，高度呈正弦拱形。
  for (let i: number = 0; i < 14; i += 1) {
    rb(
      root,
      0.15,
      0.11,
      0.18,
      materials.graphite,
      -1.15 + i * 0.17,
      2.72 + Math.sin((i / 13) * Math.PI) * 0.18,
      -1.42,
      0.025,
    );
  }

  // 前脸：控制箱 + 屏幕 + 站牌 + 台面螺栓。
  rb(root, 0.66, 1.1, 0.36, materials.porcelain, 1.42, 1.45, 1.24, 0.08);
  screen(
    root,
    materials,
    screenText ?? "LAYOUT",
    "REBUILD ENGINE",
    1.42,
    1.63,
    1.44,
    0.5,
    0.28,
  );
  label(root, "04", "REBUILD", -0.48, 0.73, 1.276, 1.05, 0.29);
  for (const x of [-1.25, 1.25]) {
    for (const z of [-0.85, 0.85]) bolt(root, materials, x, 1.56, z, "y", 0.9);
  }

  return { root, pad, gantry, head, nozzle };
}
