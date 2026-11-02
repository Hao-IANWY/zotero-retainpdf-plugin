// 站 1：OCR 识别（scanner）。
//
// 两侧立板夹出一条扫描通道，顶部是扫描头；sample() 驱动扫描条左右扫动，
// 半透明的光束跟着扫描条走。光束只在非 reduced-motion 下显示（见 pipeline-model）。

import * as THREE from "three";
import type { PipelineMaterials } from "../materials";
import {
  addStagePad,
  BELT_Y,
  bolt,
  cable,
  cyl,
  feet,
  label,
  mesh,
  rb,
  screen,
  stageRoot,
  torus,
  ventBank,
} from "./shared";
import type { StageBase, StagePad } from "./shared";

export interface ScannerStation extends StageBase {
  /** 扫描条，sample() 沿 X 轴来回滑动。 */
  scanBar: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  /** 扫描光束平面，位置跟随 scanBar。 */
  beam: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
}

export function buildScanner(
  materials: PipelineMaterials,
  screenText?: string,
): ScannerStation {
  const root: THREE.Group = stageRoot(1);
  const pad: StagePad = addStagePad(root, 1);

  feet(root, materials, 1.8, 2.45);

  // 前后两块立板：底座 + 立柱 + 内侧铝色装饰条，内外各两颗螺栓。
  for (const z of [-1.12, 1.12]) {
    rb(root, 0.72, 0.25, 0.58, materials.porcelain, 0, 0.72, z, 0.07);
    rb(root, 0.48, 2.12, 0.42, materials.porcelain, 0, 1.83, z, 0.08);
    rb(
      root,
      0.3,
      1.6,
      0.06,
      materials.aluminum,
      0,
      1.86,
      z + Math.sign(z) * 0.22,
      0.025,
    );
    for (const y of [1.0, 2.65]) {
      bolt(root, materials, 0, y, z + Math.sign(z) * 0.255, "z", 1.1);
    }
  }

  // 横梁、顶盖、扫描头与镜头圈。
  rb(root, 0.9, 0.65, 2.8, materials.porcelain, 0, 3.02, 0, 0.12);
  rb(root, 0.62, 0.18, 2.25, materials.top, 0, 3.42, 0, 0.05);
  rb(root, 0.68, 0.46, 0.74, materials.dark, 0, 2.58, 0, 0.07);
  cyl(root, 0.19, 0.22, materials.graphite, 0, 2.28, 0);
  cyl(root, 0.12, 0.025, materials.glass, 0, 2.155, 0);
  torus(root, 0.13, 0.022, materials.aluminum, 0, 2.15, 0, true);

  // 扫描条停在传送带上方一点，sample() 让它在 local progress 上做 8 个来回。
  const scanBar = rb(
    root,
    0.07,
    0.026,
    1.68,
    materials.teal,
    0,
    BELT_Y + 0.09,
    0,
    0.01,
  );
  scanBar.castShadow = false;

  // 光束用 BasicMaterial：不参与光照、双面可见，透明度压得很低，
  // 只当“扫描面”的氛围提示，不让它抢主体。
  const beamMaterial = new THREE.MeshBasicMaterial({
    color: 0x4f9f8e,
    transparent: true,
    opacity: 0.07,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const beam = mesh(
    new THREE.PlaneGeometry(1.68, 1.08),
    beamMaterial,
    root,
    0,
    1.78,
    0,
    false,
  );
  // 平面绕 Y 转 90 度，让光束横跨通道而不是正对镜头。
  beam.rotation.y = Math.PI / 2;

  screen(
    root,
    materials,
    screenText ?? "OCR",
    "OPTICAL SCAN",
    0,
    2.95,
    1.425,
    0.62,
    0.3,
  );
  ventBank(root, materials, 0, 2.64, 1.337, 5);
  label(root, "02", "OCR SCAN", 0, 1.12, 1.351, 1.05, 0.29);
  cable(
    root,
    materials,
    [
      [0.2, 3.15, -1.25],
      [0.55, 3.0, -1.45],
      [0.6, 1.0, -1.42],
      [0.25, 0.65, -1.25],
    ],
    0.035,
  );

  return { root, pad, scanBar, beam };
}
