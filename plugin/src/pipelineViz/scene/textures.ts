// 三维流水线的程序化贴图：文档页、设备屏幕、站牌三块画布全部现画。
//
// 为什么不用图片资产：贴图内容随页码（variant）和标题变化，现画一张画布比
// 维护一组 PNG 更省体积，也免了构建期的资源拷贝步骤。
// 为什么强调确定性：每张画布都用固定种子生成伪随机段落，同一个 variant 每次
// 得到完全相同的像素，视觉回归（capture 单帧）才有稳定的对照基线。
//
// 浏览器全局 document 只在函数被调用时使用，模块顶层保持无副作用：
// scene/ 下的模块会被懒加载 chunk 静态 import，导入阶段不能碰 DOM。
// 插件侧经懒 chunk 跑在中控台窗口作用域，document 由注入环境提供。

import * as THREE from "three";

declare const document: Document;

/**
 * 复刻演示里的 mulberry32 伪随机数发生器。
 * 可变状态 seed 收在闭包里，调用方拿到一条一次性的随机序列；
 * 同一种子必然产生同一序列，贴图因此可复现。
 */
function seeded(initialSeed: number): () => number {
  let seed: number = initialSeed | 0;
  return (): number => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t: number = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 取 2D 上下文；环境不支持时直接抛错，避免把 null 一路传进绘制调用。 */
function require2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  // Zotero 沙箱类型把 getContext 的返回声明成 nsISupports，运行期是标准 2D 上下文。
  const ctx = canvas.getContext(
    "2d",
  ) as unknown as CanvasRenderingContext2D | null;
  if (!ctx) {
    throw new Error("二维画布上下文不可用，无法生成程序化贴图");
  }
  return ctx;
}

/**
 * 统一贴图参数：sRGB 色彩空间保证颜色经过三维光照后不发灰；
 * 4 倍各向异性让倾斜视角下的文字边缘不发糊。
 */
function toCanvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture: THREE.CanvasTexture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * 画一页模拟论文版式，返回画布。
 * variant 决定章节标题和页码，也混进随机种子，让不同页的段落长短、灰色提示
 * 行各不相同；width/height 默认 640×820（设计稿尺寸），传其他尺寸时整体缩放，
 * 布局坐标始终按 640×820 书写。
 */
export function createDocumentCanvas(
  variant: number = 0,
  width: number = 640,
  height: number = 820,
): HTMLCanvasElement {
  const canvas: HTMLCanvasElement = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx: CanvasRenderingContext2D = require2dContext(canvas);
  const rand: () => number = seeded(9107 + variant * 37);
  const sx: number = width / 640;
  const sy: number = height / 820;
  ctx.scale(sx, sy);

  // 纸面底色：略带暖调的米白，比纯白更像印刷纸。
  ctx.fillStyle = "#f8f8f5";
  ctx.fillRect(0, 0, 640, 820);
  ctx.fillStyle = "#20292c";
  ctx.textAlign = "center";
  ctx.font = "700 19px Georgia, serif";
  ctx.fillText("BabelDOC: Layout-Preserving", 320, 56);
  ctx.fillText("PDF Translation via Intermediate", 320, 81);
  ctx.fillText("Representation", 320, 106);
  ctx.font = "11px Arial, sans-serif";
  ctx.fillStyle = "#687174";
  ctx.fillText("Document Intelligence Lab · Technical Report", 320, 132);
  ctx.textAlign = "left";

  // 正文行：统一的灰色短条代替真实字形，远看就是成段的文字。
  const line = (
    x: number,
    y: number,
    w: number,
    color: string = "#b7bcb9",
    h: number = 4,
  ): void => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };

  // 段落：最后一行刻意留短（模拟自然段收尾），其余行随机裁掉 0~8%；
  // 每 7 行挑一行用深一点的灰，制造“强调句”的视觉节奏。
  const paragraph = (
    x: number,
    y: number,
    w: number,
    rows: number,
    seedOffset: number = 0,
  ): void => {
    for (let i: number = 0; i < rows; i += 1) {
      const trim: number =
        i === rows - 1 ? 0.28 + rand() * 0.35 : rand() * 0.08;
      line(
        x,
        y + i * 12,
        w * (1 - trim),
        i % 7 === seedOffset ? "#929b98" : "#c2c6c3",
        3.4,
      );
    }
  };

  // 左栏：摘要 + 版式分析。
  ctx.fillStyle = "#263034";
  ctx.font = "700 13px Georgia, serif";
  ctx.fillText(variant % 2 ? "1  Introduction" : "Abstract", 54, 177);
  paragraph(54, 193, 244, 18, 2);
  paragraph(54, 424, 244, 19, 4);
  ctx.font = "700 13px Georgia, serif";
  ctx.fillStyle = "#263034";
  ctx.fillText("2  Layout Analysis", 54, 674);
  paragraph(54, 691, 244, 6, 1);

  // 右栏：方法章节和一张阅读顺序示意图。
  ctx.fillStyle = "#263034";
  ctx.font = "700 13px Georgia, serif";
  ctx.fillText("3  Method", 342, 177);
  paragraph(342, 193, 244, 12, 3);

  ctx.strokeStyle = "#7f8c8b";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(354, 347, 220, 126);
  ctx.fillStyle = "#e7eeeb";
  ctx.fillRect(355, 348, 218, 125);
  const bars: number[] = [0.45, 0.73, 0.58, 0.86, 0.66];
  bars.forEach((v: number, i: number): void => {
    // 第三根柱子用强调色，暗示“当前行/最值得关注的一项”。
    ctx.fillStyle = i === 3 ? "#6a8f83" : "#a8b8b2";
    ctx.fillRect(373 + i * 38, 447 - v * 72, 20, v * 72);
  });
  ctx.strokeStyle = "#8d9996";
  ctx.beginPath();
  ctx.moveTo(368, 449);
  ctx.lineTo(561, 449);
  ctx.stroke();
  ctx.font = "10px Arial, sans-serif";
  ctx.fillStyle = "#697572";
  ctx.fillText("Figure 1. Reading-order reconstruction", 370, 490);

  paragraph(342, 515, 244, 12, 5);
  ctx.font = "italic 17px Georgia, serif";
  ctx.fillStyle = "#45514f";
  ctx.fillText("L = Σ  pᵢ log qᵢ  +  λR", 390, 684);
  paragraph(342, 708, 244, 5, 2);

  // 页脚：一条细分隔线、报告名和页码（页码用 variant + 1，从 01 起）。
  ctx.strokeStyle = "#d7dad6";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(54, 775);
  ctx.lineTo(586, 775);
  ctx.stroke();
  ctx.font = "10px Arial, sans-serif";
  ctx.fillStyle = "#7c8582";
  ctx.fillText("RETAINPDF · DOCUMENT TRANSLATION", 54, 796);
  ctx.textAlign = "right";
  ctx.fillText(String(variant + 1).padStart(2, "0"), 586, 796);
  return canvas;
}

/**
 * 贴到纸张正面的文档纹理。
 * 演示固定用 512×656：比设计稿 640×820 小一圈，在纸张网格的显存占用和清晰度
 * 之间取平衡；布局仍按设计稿坐标缩放绘制。
 */
export function createDocumentTexture(
  variant: number = 0,
): THREE.CanvasTexture {
  return toCanvasTexture(createDocumentCanvas(variant, 512, 656));
}

/**
 * 设备屏幕贴图：深色底 + 32px 网格线模拟显示器，左侧强调色竖条标出站名，
 * 下方一条静态进度条（演示不驱动它，只作为“系统在跑”的氛围）。
 */
export function createScreenTexture(
  title: string,
  subtitle: string,
  accent: string = "#77b6a4",
): THREE.CanvasTexture {
  const canvas: HTMLCanvasElement = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx: CanvasRenderingContext2D = require2dContext(canvas);

  ctx.fillStyle = "#172022";
  ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = "#243033";
  for (let x: number = 0; x < 512; x += 32) {
    ctx.fillRect(x, 0, 1, 256);
  }
  for (let y: number = 0; y < 256; y += 32) {
    ctx.fillRect(0, y, 512, 1);
  }
  ctx.fillStyle = accent;
  ctx.fillRect(32, 32, 7, 54);
  ctx.font = "700 34px Arial, sans-serif";
  ctx.fillText(title, 58, 66);
  ctx.fillStyle = "#a9b8b5";
  ctx.font = "18px monospace";
  ctx.fillText(subtitle, 34, 112);
  ctx.fillStyle = "#31413f";
  ctx.fillRect(34, 150, 444, 12);
  ctx.fillStyle = accent;
  ctx.fillRect(34, 150, 276, 12);
  ctx.fillStyle = "#8da19b";
  ctx.font = "15px monospace";
  ctx.fillText("SYSTEM ONLINE  /  60 Hz", 34, 208);

  return toCanvasTexture(canvas);
}

/**
 * 站牌贴图：透明背景上的圆角牌，左边站点代号、右边中文/英文说明。
 * 先 clearRect 清成透明，配合材质 transparent 让牌子的圆角外露出来。
 */
export function createLabelTexture(
  code: string,
  label: string,
): THREE.CanvasTexture {
  const canvas: HTMLCanvasElement = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 144;
  const ctx: CanvasRenderingContext2D = require2dContext(canvas);

  ctx.clearRect(0, 0, 512, 144);
  ctx.fillStyle = "#e9ece9";
  ctx.beginPath();
  ctx.roundRect(2, 2, 508, 140, 22);
  ctx.fill();
  ctx.fillStyle = "#26302f";
  ctx.font = "700 46px Arial, sans-serif";
  ctx.fillText(code, 28, 88);
  ctx.fillStyle = "#69736f";
  ctx.font = "600 27px Arial, sans-serif";
  ctx.fillText(label, 128, 84);

  return toCanvasTexture(canvas);
}
