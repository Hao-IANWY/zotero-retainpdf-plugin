// 三维流水线总装：底座 + 五台设备 + 传送带上的移动纸张，以及驱动它们的 sample()。
//
// 这是 models.js 里 createPipelineModel 的移植版。和演示的差异只有两处，都是
// 引擎需要的扩展：
//   1. screenTexts 可替换设备屏文案（真实模型名/页码），默认保留演示文案；
//   2. PipelineSampleState.failedIndex 可把某一站标成失败（垫子/指示灯变红、
//      该站动画停在原地），供真实任务的失败终态使用。
//
// 模块顶层只放常量与冻结数组；材质、颜色对象、集合全部在工厂函数内创建，
// 这样每次销毁重建都拿到干净实例，也满足全局单例门禁。

import * as THREE from "three";
import { createDocumentTexture } from "./textures";
import { createPipelineMaterials, mergeStaticStage } from "./materials";
import type { PipelineMaterials } from "./materials";
import { paperMesh } from "./paper";
import { buildFeeder } from "./stations/feeder";
import type { FeederStation } from "./stations/feeder";
import { buildScanner } from "./stations/scanner";
import type { ScannerStation } from "./stations/scanner";
import { buildTranslator } from "./stations/translator";
import type { TranslatorStation } from "./stations/translator";
import { buildLayout } from "./stations/layout";
import type { LayoutStation } from "./stations/layout";
import { buildOutput } from "./stations/output";
import type { OutputStation } from "./stations/output";
import { BELT_Y, cyl, rb } from "./stations/shared";

export { BASE_TOP, BELT_Y, STAGE_X } from "./stations/shared";

/** 五站各自的设计时长（秒），加起来就是整条线的循环长度。 */
export const STAGE_DURATIONS: readonly number[] = Object.freeze([
  4, 5, 8, 6, 4,
]);
/** 整个模拟的总时长，演示里是 27 秒。 */
export const TOTAL_DURATION: number = STAGE_DURATIONS.reduce(
  (sum: number, duration: number): number => sum + duration,
  0,
);
/** 传送带上同时在途的纸张数；演示固定 10 张，多一张少一张都会让节奏变稀。 */
export const MOVING_PAGE_COUNT: number = 10;

/** 设备屏文案覆盖的站键，和 machines 数组的顺序一致。 */
export type PipelineStationKey =
  | "feeder"
  | "scanner"
  | "translator"
  | "layout"
  | "output";

/**
 * 引擎每帧交给 sample() 的状态。
 * - stageIndex/stageProgress：当前进行到哪一站、站内进度（0..1）；
 * - overall/complete：整体进度与是否完成（完成时五站一律按 done 显示）；
 * - motion：动画幅度因子，prefers-reduced-motion 时传 0；
 * - failedIndex：失败站索引，null 表示没有失败。
 */
export type PipelineSampleState = {
  stageIndex: number;
  stageProgress: number;
  overall: number;
  complete: boolean;
  motion: number;
  failedIndex: number | null;
};

export interface PipelineModelOptions {
  /**
   * 覆盖设备屏上的默认文案。语义按设备区分：
   * - feeder 替换页码行（默认 "PAGE 01 / 10"），标题 FEED 不变；
   * - translator 替换标题（默认 "QWEN 3.8"），副标题 TRANSLATION CORE 不变；
   * - scanner/layout/output 替换标题，副标题不变。
   * 这样引擎传真实模型名/页码时，换掉的正是那块会过时的信息。
   */
  screenTexts?: Partial<Record<PipelineStationKey, string>>;
}

export interface PipelineModel {
  group: THREE.Group;
  machines: THREE.Object3D[];
  movingPages: THREE.Group[];
  sample(simT: number, state: PipelineSampleState): void;
}

// 站台状态用整数表示，避免每帧创建字符串。
const STATUS_IDLE: number = 0;
const STATUS_ACTIVE: number = 1;
const STATUS_DONE: number = 2;

export function createPipelineModel(
  options: PipelineModelOptions = {},
): PipelineModel {
  const materials: PipelineMaterials = createPipelineMaterials();
  const group = new THREE.Group();
  group.name = "文献翻译流水线";

  // 底座：浅色台面 + 铝色踢脚 + 一排橡胶支脚。
  // 和演示一样用圆角盒，避免长条台面的棱角在低角度镜头下过锐。
  const base = rb(group, 20.6, 0.34, 5.6, materials.top, 0, 0.19, 0, 0.16);
  base.receiveShadow = true;
  rb(group, 20.1, 0.13, 5.15, materials.aluminum, 0, 0.055, 0, 0.06);
  for (const x of [-8.8, -4.4, 0, 4.4, 8.8]) {
    for (const z of [-2.15, 2.15]) {
      cyl(group, 0.16, 0.12, materials.rubber, x, -0.04, z);
    }
  }

  // 五台设备按屏幕文案覆盖参数构建。
  const feeder: FeederStation = buildFeeder(
    materials,
    options.screenTexts?.feeder,
  );
  const scanner: ScannerStation = buildScanner(
    materials,
    options.screenTexts?.scanner,
  );
  const translator: TranslatorStation = buildTranslator(
    materials,
    options.screenTexts?.translator,
  );
  const layout: LayoutStation = buildLayout(
    materials,
    options.screenTexts?.layout,
  );
  const output: OutputStation = buildOutput(
    materials,
    options.screenTexts?.output,
  );
  const machines = [feeder, scanner, translator, layout, output];

  // 合批时要跳过的动态子树：这些对象会被 sample() 改位置/可见性/材质，
  // 或者为了逐颗控制材质而不能合并。
  const dynamicRoots: Set<THREE.Object3D> = new Set<THREE.Object3D>([
    feeder.feedPage,
    scanner.scanBar,
    scanner.beam,
    layout.gantry,
    ...translator.rackLeds,
    ...output.outputPages,
    ...machines.flatMap((machine): THREE.Mesh[] => [
      machine.pad.pad,
      machine.pad.indicator,
    ]),
  ]);
  machines.forEach((machine): void => {
    mergeStaticStage(machine.root, dynamicRoots);
    group.add(machine.root);
  });

  // 移动纸张：贴图按 i % 3 轮换三种版式，沿传送带从进纸口滑到输出站。
  const movingPages: THREE.Group[] = [];
  for (let i: number = 0; i < MOVING_PAGE_COUNT; i += 1) {
    const page: THREE.Group = paperMesh(
      materials,
      createDocumentTexture(i % 3),
      1.04,
      1.38,
    );
    page.name = `moving-page-${i + 1}`;
    page.castShadow = false;
    group.add(page);
    movingPages.push(page);
  }

  // sample() 每帧复用这些颜色对象，避免在渲染循环里反复 new Color。
  const teal: THREE.Color = new THREE.Color(0x4f9f8e);
  const green: THREE.Color = new THREE.Color(0x68a37f);
  const idle: THREE.Color = new THREE.Color(0x87918d);
  const padIdle: THREE.Color = new THREE.Color(0xdde2de);
  const padActive: THREE.Color = new THREE.Color(0xcbded7);
  const padDone: THREE.Color = new THREE.Color(0xd5e1d8);
  const failColor: THREE.Color = new THREE.Color(0xd9534f);
  const failPadColor: THREE.Color = new THREE.Color(0xe4c3c0);

  function sample(simT: number, state: PipelineSampleState): void {
    const active: number = state.stageIndex;
    const finished: boolean = state.complete || simT >= TOTAL_DURATION;
    const failedIndex: number | null = state.failedIndex;
    const motion: number = state.motion;
    const local: number = state.stageProgress;

    // 垫子与指示灯：失败优先于 done/active/idle；失败站不再进入后面的动画分支。
    machines.forEach((machine, i: number): void => {
      if (failedIndex === i) {
        machine.pad.indicatorMat.color.copy(failColor);
        machine.pad.indicatorMat.emissive.copy(failColor);
        machine.pad.indicatorMat.emissiveIntensity = 1.2;
        machine.pad.material.color.copy(failPadColor);
        machine.pad.material.emissive.copy(failColor);
        machine.pad.material.emissiveIntensity = 0.22;
        return;
      }
      const status: number =
        i < active || finished
          ? STATUS_DONE
          : i === active
            ? STATUS_ACTIVE
            : STATUS_IDLE;
      const color: THREE.Color =
        status === STATUS_DONE ? green : status === STATUS_ACTIVE ? teal : idle;
      machine.pad.indicatorMat.color.copy(color);
      machine.pad.indicatorMat.emissive.copy(color);
      machine.pad.indicatorMat.emissiveIntensity =
        status === STATUS_ACTIVE ? 1.4 : 0.35;
      machine.pad.material.color.copy(
        status === STATUS_DONE
          ? padDone
          : status === STATUS_ACTIVE
            ? padActive
            : padIdle,
      );
      // 非失败时把垫子的自发光恢复成演示的青色，失败那帧染的红才会被清掉。
      machine.pad.material.emissive.copy(teal);
      machine.pad.material.emissiveIntensity =
        status === STATUS_ACTIVE ? 0.08 : 0;
    });

    // 站 0：抬起并翻转进纸页。失败时停在当前姿态，且保持可见。
    if (failedIndex === 0) {
      feeder.feedPage.visible = true;
    } else {
      feeder.feedPage.position.x = 0.32 + (active === 0 ? local * 0.65 : 0.15);
      feeder.feedPage.position.y = 1.62 - (active === 0 ? local * 0.32 : 0.12);
      feeder.feedPage.rotation.z = -0.28 + (active === 0 ? local * 0.28 : 0.1);
      feeder.feedPage.visible = active === 0 && !finished;
    }

    // 站 1：扫描条沿 8 个来回扫动，光束跟随；失败时两者冻结在原地。
    if (failedIndex === 1) {
      scanner.scanBar.visible = true;
      scanner.beam.visible = motion > 0;
    } else {
      scanner.scanBar.position.x =
        active === 1 ? Math.sin(local * Math.PI * 8) * 0.48 * motion : 0;
      scanner.beam.position.x = scanner.scanBar.position.x;
      scanner.scanBar.visible = active === 1 && !finished;
      scanner.beam.visible = scanner.scanBar.visible && motion > 0;
    }

    // 站 2：四颗指示灯按索引错相呼吸；失败时不再更新，停在当前亮度。
    if (failedIndex !== 2) {
      translator.rackLeds.forEach((led, i: number): void => {
        led.material.emissiveIntensity =
          active === 2
            ? 0.5 + 1.4 * (0.5 + 0.5 * Math.sin(simT * 5 + i * 1.7) * motion)
            : finished
              ? 0.8
              : 0.15;
      });
    }

    // 站 3：龙门走 X、打印头走 Z，两个频率不同才像在逐行重排。
    if (failedIndex !== 3) {
      layout.gantry.position.x =
        active === 3 ? Math.sin(local * Math.PI * 4) * 0.68 * motion : 0;
      layout.head.position.z =
        active === 3 ? Math.sin(local * Math.PI * 10) * 0.72 * motion : 0;
    }

    // 站 4：输出纸页按进度逐张显示；失败时冻结当前张数。
    if (failedIndex !== 4) {
      const outputRatio: number = finished ? 1 : active === 4 ? local : 0;
      output.outputPages.forEach((page: THREE.Group, i: number): void => {
        page.visible =
          i < Math.max(3, Math.floor(outputRatio * output.outputPages.length));
      });
    }

    // 传送带上的纸张：整体进度决定每张纸的纵向位置（演示原式保留）。
    movingPages.forEach((page: THREE.Group, i: number): void => {
      const progress: number = THREE.MathUtils.clamp(
        (simT / TOTAL_DURATION) * 1.38 - i * 0.042,
        0,
        1,
      );
      page.visible = progress > 0.002 && progress < 0.992;
      page.position.x = -8.55 + progress * 17.1;
      page.position.y = BELT_Y + 0.065 + Math.sin(progress * Math.PI) * 0.02;
      page.position.z = Math.sin(i * 2.3) * 0.035;
      page.rotation.y = Math.sin(i * 1.4) * 0.018;
      page.rotation.z = progress < 0.06 ? -0.14 * (1 - progress / 0.06) : 0;
    });
  }

  // 收尾标记：给每个网格打 pipelinePart，并让拾取/高亮能从子网格回溯到站号；
  // 太小的零件（螺栓、栅条）关掉投影，阴影贴图省一半以上。
  group.traverse((object: THREE.Object3D): void => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.castShadow) {
      let box: THREE.Box3 | null = object.geometry.boundingBox;
      if (!box) {
        object.geometry.computeBoundingBox();
        box = object.geometry.boundingBox;
      }
      if (box) {
        const size: THREE.Vector3 = box.getSize(new THREE.Vector3());
        if (Math.max(size.x, size.y, size.z) < 0.22) object.castShadow = false;
      }
    }
    object.userData.pipelinePart = true;
    let parent: THREE.Object3D | null = object.parent;
    while (parent && parent.userData.stageIndex === undefined)
      parent = parent.parent;
    if (parent) {
      const stageIndex: unknown = parent.userData.stageIndex;
      if (stageIndex !== undefined) object.userData.stageIndex = stageIndex;
    }
  });

  return {
    group,
    machines: machines.map((machine): THREE.Object3D => machine.root),
    movingPages,
    sample,
  };
}
