// 站 0：文档准备（feeder）。
//
// 造型是一摞待送进流水线的纸 + 一台把最上面一页抬起来的进纸机构；sample() 里
// 只有 feedPage 会动（抬起、翻转着送向下一站），纸堆本身是静态背景。
// 屏幕默认显示 FEED / PAGE 01 / 10，页码文案可由 createPipelineModel 的
// screenTexts.feeder 换成真实页码。

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
  rb,
  screen,
  stageRoot,
  ventBank,
} from "./shared";
import type { StageBase, StagePad } from "./shared";

export interface FeederStation extends StageBase {
  /** 正在被抬起的纸页，sample() 驱动它的位置与翻转。 */
  feedPage: THREE.Group;
  /** 进纸口前的一摞纸（静态）。 */
  stack: THREE.Group;
}

export function buildFeeder(
  materials: PipelineMaterials,
  screenText?: string,
): FeederStation {
  const root: THREE.Group = stageRoot(0);
  const pad: StagePad = addStagePad(root, 0);

  feet(root, materials, 2.25, 2.35);
  rb(root, 2.5, 0.34, 0.38, materials.porcelain, 0, 0.7, -1.15, 0.09);
  rb(root, 2.5, 0.34, 0.38, materials.porcelain, 0, 0.7, 1.15, 0.09);

  // 四根立柱 + 顶部的深色端盖，撑起进纸机构。
  for (const x of [-1.12, 0.35]) {
    for (const z of [-0.84, 0.84]) {
      rb(root, 0.11, 1.55, 0.11, materials.aluminum, x, 1.55, z, 0.025);
      cyl(root, 0.085, 0.08, materials.dark, x, 2.34, z);
    }
  }

  rb(root, 1.7, 0.12, 1.86, materials.dark, -0.4, 1.18, 0, 0.04);

  // 纸堆：38 张只给最上面一张贴文档图，其余保持纯纸色；每张加极小的
  // 位置/旋转抖动，远看才有“一摞散纸”的厚度感，而不是一块实心盒子。
  const stack = new THREE.Group();
  stack.position.set(-0.45, 1.29, 0);
  root.add(stack);
  const texture: THREE.CanvasTexture = createDocumentTexture(0);
  for (let i: number = 0; i < 38; i += 1) {
    const page: THREE.Group = paperMesh(
      materials,
      i === 37 ? texture : null,
      1.16,
      1.48,
    );
    page.position.set(
      Math.sin(i * 2.1) * 0.008,
      i * 0.019,
      Math.cos(i * 1.7) * 0.008,
    );
    page.rotation.y = Math.sin(i * 0.8) * 0.004;
    page.castShadow = i === 37;
    stack.add(page);
  }

  // 进纸臂与压轮。
  rb(root, 1.85, 0.18, 0.18, materials.porcelain, -0.35, 2.48, -0.91, 0.05);
  rb(root, 0.24, 0.28, 2.0, materials.porcelain, -1.18, 2.42, 0, 0.06);
  cyl(root, 0.11, 0.75, materials.dark, -0.4, 2.25, 0, "x");
  for (const z of [-0.48, 0.48]) {
    cyl(root, 0.1, 0.16, materials.rubber, -0.02, 2.13, z);
    cyl(root, 0.04, 0.35, materials.aluminum, -0.02, 2.33, z);
  }

  // 被吸起来的那一页；初始状态就是 sample() 里 active=0、progress=0 的位置。
  const feedPage: THREE.Group = paperMesh(materials, texture);
  feedPage.position.set(0.42, 1.62, 0);
  feedPage.rotation.z = -0.28;
  root.add(feedPage);

  // 前脸：控制箱、屏幕、散热栅、螺栓和站牌。
  rb(root, 0.72, 1.0, 0.38, materials.porcelain, 0.85, 1.33, 1.15, 0.09);
  screen(
    root,
    materials,
    "FEED",
    screenText ?? "PAGE 01 / 10",
    0.85,
    1.52,
    1.36,
    0.54,
    0.28,
  );
  ventBank(root, materials, 0.85, 1.08, 1.351, 4);
  for (const x of [-1.1, 1.1]) {
    for (const y of [0.62, 0.78]) bolt(root, materials, x, y, 1.351);
  }
  label(root, "01", "DOCUMENT", -0.58, 0.73, 1.351, 1.05, 0.29);

  return { root, pad, feedPage, stack };
}
