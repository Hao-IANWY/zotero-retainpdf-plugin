// 站 2：文本翻译（translator）。
//
// 造型像一台机架式服务器：正面四层硬盘位、每层一颗状态灯，中间是玻璃门，
// 顶部两个风扇。sample() 只驱动四颗指示灯的自发光强度，做出“正在算”的呼吸感。
// 屏幕默认写 QWEN 3.8 / TRANSLATION CORE，模型名可由 screenTexts.translator 替换。

import * as THREE from "three";
import type { PipelineMaterials } from "../materials";
import {
  addStagePad,
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
} from "./shared";
import type { StageBase, StagePad } from "./shared";

export interface TranslatorStation extends StageBase {
  /** 四颗机架指示灯，各自持有材质，才能按索引错相呼吸。 */
  rackLeds: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>[];
  /** 正面玻璃门；合批时因 transparent 被排除，保持单独渲染。 */
  glass: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;
}

export function buildTranslator(
  materials: PipelineMaterials,
  screenText?: string,
): TranslatorStation {
  const root: THREE.Group = stageRoot(2);
  const pad: StagePad = addStagePad(root, 2);

  feet(root, materials, 2.55, 2.35);
  rb(root, 2.9, 0.34, 2.65, materials.porcelain, 0, 0.7, 0, 0.1);

  // 左右侧板 + 内侧铝色装饰条。
  for (const x of [-1.3, 1.3]) {
    rb(root, 0.3, 2.45, 2.5, materials.porcelain, x, 2.0, 0, 0.08);
    rb(
      root,
      0.08,
      1.7,
      2.1,
      materials.aluminum,
      x - Math.sign(x) * 0.17,
      2.12,
      0,
      0.025,
    );
  }
  rb(root, 2.9, 0.38, 2.65, materials.porcelain, 0, 3.35, 0, 0.11);
  rb(root, 2.5, 2.1, 0.16, materials.graphite, 0, 2.12, -1.16, 0.04);
  rb(root, 2.38, 0.16, 0.75, materials.dark, 0, 1.48, 0.58, 0.04);

  // 四层机架：每层一块石墨面板、一条深色缝、八个假硬盘位和一颗指示灯。
  // 指示灯材质必须每颗独立（sample() 按索引给不同相位），不能共用。
  const rackLeds: THREE.Mesh<
    THREE.CylinderGeometry,
    THREE.MeshStandardMaterial
  >[] = [];
  for (let i: number = 0; i < 4; i += 1) {
    const y: number = 1.76 + i * 0.38;
    rb(root, 2.15, 0.3, 0.92, materials.graphite, 0, y, 0.47, 0.035);
    rb(root, 1.62, 0.18, 0.035, materials.dark, -0.14, y, 0.945, 0.015);
    for (let j: number = 0; j < 8; j += 1) {
      rb(
        root,
        0.055,
        0.11,
        0.02,
        materials.rubber,
        -0.77 + j * 0.17,
        y,
        0.97,
        0.008,
      ).castShadow = false;
    }
    const ledMaterial = new THREE.MeshStandardMaterial({
      color: 0x5c9e87,
      roughness: 0.25,
      metalness: 0.1,
      emissive: 0x5c9e87,
      emissiveIntensity: 0.4,
    });
    const led = cyl(root, 0.032, 0.018, ledMaterial, 0.88, y, 0.98, "z", 12);
    led.castShadow = false;
    rackLeds.push(led);
    for (const x of [-1.0, 1.0]) bolt(root, materials, x, y, 0.97, "z", 0.7);
  }

  // 玻璃门与铝色门框。
  const glass = mesh(
    new THREE.PlaneGeometry(2.35, 1.65),
    materials.glass,
    root,
    0,
    2.32,
    1.09,
    false,
  );
  rb(root, 2.5, 0.09, 0.09, materials.aluminum, 0, 3.18, 1.1, 0.02);
  rb(root, 2.5, 0.09, 0.09, materials.aluminum, 0, 1.46, 1.1, 0.02);
  for (const x of [-1.2, 1.2]) {
    rb(root, 0.08, 1.8, 0.09, materials.aluminum, x, 2.32, 1.1, 0.02);
  }

  // 顶部风扇：轴心 + 外圈 + 三片扇叶（绕 Y 相隔 60 度）。
  for (const x of [-0.65, 0.65]) {
    cyl(root, 0.32, 0.06, materials.dark, x, 3.57, 0, "y", 32);
    torus(root, 0.27, 0.025, materials.aluminum, x, 3.61, 0, true);
    for (let bladeIndex: number = 0; bladeIndex < 3; bladeIndex += 1) {
      const blade = rb(
        root,
        0.4,
        0.025,
        0.09,
        materials.graphite,
        x,
        3.615,
        0,
        0.02,
      );
      blade.rotation.y = (bladeIndex * Math.PI) / 3;
    }
  }

  screen(
    root,
    materials,
    screenText ?? "QWEN 3.8",
    "TRANSLATION CORE",
    0,
    3.34,
    1.351,
    1.02,
    0.25,
  );
  label(root, "03", "TRANSLATE", 0, 0.73, 1.351, 1.14, 0.29);

  cable(
    root,
    materials,
    [
      [-0.8, 2.9, -1.3],
      [-1.6, 2.7, -1.5],
      [-1.55, 0.65, -1.45],
      [-0.8, 0.5, -1.25],
    ],
    0.055,
  );
  cable(
    root,
    materials,
    [
      [0.6, 3.0, -1.3],
      [1.55, 2.65, -1.52],
      [1.5, 0.8, -1.45],
      [0.9, 0.5, -1.25],
    ],
    0.035,
    materials.aluminum,
  );

  return { root, pad, rackLeds, glass };
}
