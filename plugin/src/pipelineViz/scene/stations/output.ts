// 站 4：完成输出（output）。
//
// 一只倾斜的接纸托盘，托盘里叠着 26 张译文页；sample() 按整体进度逐张
// 把纸页 visible 打开，形成“输出正在堆起来”的效果，最后一张带文档贴图。
// 托盘侧面挂一颗绿色对勾环，表示导出就绪。

import * as THREE from "three";
import { createDocumentTexture } from "../textures";
import type { PipelineMaterials } from "../materials";
import { paperMesh } from "../paper";
import {
  addStagePad,
  feet,
  label,
  rb,
  screen,
  stageRoot,
  torus,
} from "./shared";
import type { StageBase, StagePad } from "./shared";

export interface OutputStation extends StageBase {
  /** 托盘里的输出纸页，sample() 按序号控制可见数量。 */
  outputPages: THREE.Group[];
  /** 倾斜的接纸托盘（静态）。 */
  tray: THREE.Group;
  /** 对勾环（静态）。 */
  check: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>;
}

export function buildOutput(
  materials: PipelineMaterials,
  screenText?: string,
): OutputStation {
  const root: THREE.Group = stageRoot(4);
  const pad: StagePad = addStagePad(root, 4);

  feet(root, materials, 2.15, 2.35);
  rb(root, 2.4, 0.36, 0.42, materials.porcelain, 0, 0.72, -1.14, 0.09);
  rb(root, 2.4, 0.36, 0.42, materials.porcelain, 0, 0.72, 1.14, 0.09);

  // 托盘整体后仰 7.5 度，纸页叠放时才不会看起来像悬空。
  const tray = new THREE.Group();
  tray.position.set(0.35, 1.2, 0);
  tray.rotation.z = -0.13;
  root.add(tray);
  rb(tray, 1.75, 0.12, 1.92, materials.dark, 0, 0, 0, 0.035);
  for (const z of [-0.93, 0.93]) {
    rb(tray, 1.85, 0.5, 0.09, materials.aluminum, 0, 0.26, z, 0.025);
    rb(tray, 0.12, 1.6, 0.12, materials.porcelain, -0.86, 0.8, z, 0.03);
  }
  rb(tray, 0.14, 1.55, 1.95, materials.porcelain, -0.88, 0.78, 0, 0.04);

  // 26 张输出页：只有最上面一张贴文档图，和进纸纸堆同一套省钱做法。
  const outputPages: THREE.Group[] = [];
  const texture: THREE.CanvasTexture = createDocumentTexture(9);
  for (let i: number = 0; i < 26; i += 1) {
    const page: THREE.Group = paperMesh(
      materials,
      i === 25 ? texture : null,
      1.42,
      1.65,
    );
    page.position.set(
      0.04 + Math.sin(i * 1.4) * 0.006,
      0.1 + i * 0.02,
      Math.cos(i * 1.9) * 0.005,
    );
    page.castShadow = i === 25;
    tray.add(page);
    outputPages.push(page);
  }

  // 前脸控制箱、屏幕、对勾环与站牌。
  rb(root, 0.6, 1.05, 0.38, materials.porcelain, -0.85, 1.35, 1.15, 0.09);
  screen(
    root,
    materials,
    screenText ?? "DONE",
    "EXPORT READY",
    -0.85,
    1.55,
    1.36,
    0.46,
    0.27,
  );
  const check = torus(
    root,
    0.18,
    0.035,
    materials.teal,
    -0.85,
    1.12,
    1.37,
    false,
  );
  label(root, "05", "COMPLETE", 0.35, 0.73, 1.351, 1.08, 0.29);

  return { root, pad, outputPages, tray, check };
}
