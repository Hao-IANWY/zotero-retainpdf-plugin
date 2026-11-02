// 传送带设计资产的加载会话：从网页端 src/assets/pipeline-viz/conveyor/ 的
// loader.mjs + asset.mjs 移植（同一作者仓库间搬运，许可随文件带走，见
// addon/content/pipeline-viz/conveyor/THREE-LICENSE.txt 与 README.md）。
//
// 与原版的差异只有一处：资产基址不再是 import.meta.url 相对解析，而是由
// 调用方显式传入 chrome://retainpdf/content/pipeline-viz/conveyor/——插件
// chunk 经 <script> 注入窗口，import.meta.url 不可靠。资源仍按 gz 原样伺服，
// fetch + DecompressionStream 解压；任一环节失败由 conveyor.ts 回退参数化
// 传送带，这里的异常全部向上抛。

import type * as THREE_NS from "three";

/** 资产清单里一个数据段（几何顶点/索引/贴图字节）的定位描述。 */
interface AssetBlockRef {
  file: string;
  offset: number;
  length: number;
  type?: "u32" | "f32";
}

/** 资产清单（data.json.gz 解出的结构，只声明加载用到的字段）。 */
interface AssetManifest {
  states: Record<string, unknown>;
  statePacks: Record<string, string[]>;
  materials: Record<
    string,
    {
      name: string;
      properties: Record<string, any>;
      maps: Record<string, string>;
    }
  >;
  geometries: Record<string, Record<string, any>>;
  textures: Record<string, AssetBlockRef & { mime: string }>;
}

/** 状态节点（Blender 保存场景导出的层级项）。 */
interface AssetNode {
  name: string;
  parent: string;
  geometry?: string | null;
  materials?: string[];
  visible?: boolean;
  matrix: number[];
  properties?: Record<string, unknown>;
  type?: string;
}

type ThreeNS = typeof THREE_NS;
type AnyTexture = THREE_NS.Texture & Record<string, any>;
type AnyMaterial = THREE_NS.Material & Record<string, any>;
type AnyGeometry = THREE_NS.BufferGeometry & Record<string, any>;

interface AssetSession {
  data: AssetManifest;
  prepare(name: string): Promise<void>;
  array(ref: AssetBlockRef): Uint32Array | Float32Array;
  uri(id: string): string;
  release(): Promise<void>;
  loadTexture<T>(uri: string, loader: (uri: string) => Promise<T>): Promise<T>;
  geometries: Map<string, AnyGeometry>;
  textures: Map<string, Promise<unknown>>;
}

interface AssetPool {
  refs: number;
  blocks: Map<string, { buffer: ArrayBuffer | null; promise: Promise<void> }>;
  urls: Map<string, string>;
  geometries: Map<string, AnyGeometry>;
  textures: Map<string, Promise<unknown>>;
}

const pools = new WeakMap<Promise<AssetManifest>, AssetPool>();

let manifestPromise: Promise<AssetManifest> | null = null;

async function unzip(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Asset resource ${response.status}: ${url}`);
  return new Response(
    response.body!.pipeThrough(new DecompressionStream("gzip")),
  ).arrayBuffer();
}

function manifestOf(base: string): Promise<AssetManifest> {
  manifestPromise ??= unzip(new URL("data.json.gz", base).href)
    .then((buffer) => JSON.parse(new TextDecoder().decode(buffer)))
    .catch((error: unknown) => {
      manifestPromise = null;
      throw error;
    });
  return manifestPromise;
}

/** 打开资产会话：拉清单、按 statePacks 预取数据块、发布贴图 blob URL。 */
async function openAsset(
  base: string,
  options: { sharedResources?: boolean },
): Promise<AssetSession> {
  const data = await manifestOf(base);
  const shared = options.sharedResources === true;
  const manifestKey = manifestPromise!;
  let poolCandidate = shared ? pools.get(manifestKey) : null;
  if (!poolCandidate) {
    poolCandidate = {
      refs: 0,
      blocks: new Map(),
      urls: new Map(),
      geometries: new Map(),
      textures: new Map(),
    };
    if (shared) pools.set(manifestKey, poolCandidate);
  }
  const pool: AssetPool = poolCandidate;
  pool.refs += 1;
  let released = false;
  let active = 0;
  const waiting: Array<() => void> = [];

  async function loadTexture<T>(
    uri: string,
    loader: (uri: string) => Promise<T>,
  ): Promise<T> {
    if (active >= 8)
      await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await loader(uri);
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  async function prepare(name: string): Promise<void> {
    if (released) throw new Error("Asset has been disposed");
    if (!data.states[name])
      throw new RangeError(`Unknown asset state: ${name}`);
    await Promise.all(
      data.statePacks[name].map(async (file) => {
        if (!pool.blocks.has(file)) {
          const block: { buffer: ArrayBuffer | null; promise: Promise<void> } =
            {
              buffer: null,
              promise: Promise.resolve(),
            };
          block.promise = unzip(new URL(file, base).href)
            .then((buffer) => {
              block.buffer = buffer;
            })
            .catch((error: unknown) => {
              pool.blocks.delete(file);
              throw error;
            });
          pool.blocks.set(file, block);
        }
        await pool.blocks.get(file)!.promise;
      }),
    );
    if (released) throw new Error("Asset has been disposed");
  }

  function bytes(ref: AssetBlockRef): Uint8Array {
    const block = pool.blocks.get(ref.file);
    if (!block?.buffer) throw new Error("Asset state has not been prepared");
    return new Uint8Array(block.buffer, ref.offset, ref.length);
  }

  function array(ref: AssetBlockRef): Uint32Array | Float32Array {
    const view = bytes(ref);
    return ref.type === "u32"
      ? new Uint32Array(view.buffer, view.byteOffset, view.byteLength / 4)
      : new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4);
  }

  function uri(id: string): string {
    const ref = data.textures[id];
    const key = `${ref.file}:${ref.offset}`;
    if (!pool.urls.has(key)) {
      pool.urls.set(
        key,
        URL.createObjectURL(new Blob([bytes(ref)], { type: ref.mime })),
      );
    }
    return pool.urls.get(key)!;
  }

  async function release(): Promise<void> {
    if (released) return;
    released = true;
    if (--pool.refs) return;
    if (shared && pools.get(manifestKey) === pool) pools.delete(manifestKey);
    await Promise.allSettled(
      [...pool.textures.values()].map(async (pending) => {
        const texture = (await pending) as { dispose?: () => void };
        texture.dispose?.();
      }),
    );
    for (const geometry of pool.geometries.values()) geometry.dispose();
    for (const url of pool.urls.values()) URL.revokeObjectURL(url);
    pool.geometries.clear();
    pool.textures.clear();
    pool.urls.clear();
    pool.blocks.clear();
  }

  return {
    data,
    prepare,
    array,
    uri,
    release,
    loadTexture,
    geometries: pool.geometries,
    textures: pool.textures,
  };
}

export const conveyorAssetMetadata = Object.freeze({
  schema: "asset-web-module/1",
  itemId: "02-G6-0004",
  name: "Straight conveyor belt",
  defaultState: "default",
  sourceUpAxis: "Z",
  units: "metres",
});

/**
 * 组装真实传送带模型：asset.mjs 的 createAsset 移植（states 固定 "lazy"，
 * 只构建默认状态）。THREE 命名空间由调用方传入，保证贴图/几何与引擎同 realm。
 */
export async function createConveyorAsset(
  THREE: ThreeNS,
  base: string,
  options: { sharedResources?: boolean } = {},
): Promise<THREE_NS.Group & Record<string, unknown>> {
  if (!THREE?.Group || !THREE?.BufferGeometry || !THREE?.MeshPhysicalMaterial) {
    throw new TypeError("Pass the three.js namespace to createConveyorAsset");
  }
  const requested = conveyorAssetMetadata.defaultState;
  const session = await openAsset(base, options);
  const data = session.data;
  try {
    if (!data.states[requested]) {
      throw new RangeError(`Unknown asset state: ${requested}`);
    }
    const materials = new Map<string, Promise<AnyMaterial>>();
    const root = new THREE.Group();
    root.name = conveyorAssetMetadata.name;
    root.userData.asset = conveyorAssetMetadata;
    // 插件场景是 Y-up（与网页端一致）；源资产 Z-up，绕 X 转 -90°。
    root.rotation.x = -Math.PI / 2;
    const loadTexture = (uri: string): Promise<AnyTexture> =>
      new THREE.TextureLoader().loadAsync(uri) as Promise<AnyTexture>;

    async function texture(id: string, color: boolean): Promise<AnyTexture> {
      const key = `${id}:${color ? "srgb" : "linear"}`;
      if (!session.textures.has(key)) {
        session.textures.set(
          key,
          (async () => {
            const map = await session.loadTexture(session.uri(id), loadTexture);
            map.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            map.flipY = true; // 原生 Blender UV，非 glTF 约定
            map.wrapS = THREE.ClampToEdgeWrapping;
            map.wrapT = THREE.ClampToEdgeWrapping;
            map.needsUpdate = true;
            return map;
          })(),
        );
      }
      return session.textures.get(key) as Promise<AnyTexture>;
    }

    async function material(id: string): Promise<AnyMaterial> {
      if (!materials.has(id)) {
        materials.set(
          id,
          (async () => {
            const spec = data.materials[id];
            const p = spec.properties;
            const m: AnyMaterial = new THREE.MeshPhysicalMaterial({
              color: new THREE.Color(...p.color),
              metalness: p.metalness,
              roughness: p.roughness,
              opacity: p.opacity,
              transparent: p.transparent,
              ior: p.ior,
              transmission: p.transmission,
              clearcoat: p.clearcoat,
              clearcoatRoughness: p.clearcoatRoughness,
              emissive: new THREE.Color(...p.emissive),
              emissiveIntensity: p.emissiveIntensity,
              specularIntensity: p.specularIntensity,
              specularColor: new THREE.Color(...p.specularColor),
              sheen: p.sheen ?? 0,
              sheenColor: new THREE.Color(...(p.sheenColor ?? [1, 1, 1])),
              sheenRoughness: p.sheenRoughness ?? 0.5,
              anisotropy: p.anisotropy ?? 0,
              anisotropyRotation: p.anisotropyRotation ?? 0,
              side: THREE.DoubleSide,
            });
            m.name = spec.name;
            m.userData.blenderMaterial = spec.name;
            for (const [prop, tex] of Object.entries(spec.maps)) {
              m[prop] = await texture(
                tex,
                prop === "map" ||
                  prop === "emissiveMap" ||
                  prop === "specularColorMap",
              );
            }
            return m;
          })(),
        );
      }
      return materials.get(id)!;
    }

    function geometry(id: string): AnyGeometry {
      const cached = session.geometries.get(id);
      if (cached) return cached;
      const d = data.geometries[id];
      const g: AnyGeometry = new THREE.BufferGeometry();
      g.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(session.array(d.position) as any, 3),
      );
      g.setAttribute(
        "normal",
        new THREE.Float32BufferAttribute(session.array(d.normal) as any, 3),
      );
      const uv = session.array(d.uv) as any;
      if (uv.length)
        g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      if (d.index)
        g.setIndex(new THREE.BufferAttribute(session.array(d.index) as any, 1));
      for (const [start, count, slot] of d.groups)
        g.addGroup(start, count, slot);
      g.computeBoundingBox();
      g.computeBoundingSphere();
      session.geometries.set(id, g);
      return g;
    }

    await session.prepare(requested);
    const state = data.states[requested] as { nodes: AssetNode[] };
    const materialIds = [
      ...new Set(
        state.nodes
          .flatMap((node) => node.materials ?? [])
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    ];
    await Promise.all(materialIds.map(material));
    const container = new THREE.Group();
    container.name = `state:${requested}`;
    const nodes = new Map<string, THREE_NS.Object3D & Record<string, any>>();
    for (const d of state.nodes) {
      const object = d.geometry
        ? new THREE.Mesh(
            geometry(d.geometry),
            await Promise.all((d.materials ?? []).map(material)),
          )
        : new THREE.Group();
      object.name = d.name;
      object.visible = d.visible !== false;
      object.matrix.fromArray(d.matrix);
      object.matrix.decompose(object.position, object.quaternion, object.scale);
      object.matrixAutoUpdate = false;
      object.userData = {
        ...(d.properties ?? {}),
        blenderType: d.type,
        assetNode: d.name,
      };
      object.castShadow = true;
      object.receiveShadow = true;
      nodes.set(d.name, object);
    }
    for (const d of state.nodes) {
      (nodes.get(d.parent) ?? container).add(nodes.get(d.name)!);
    }
    container.visible = true;
    root.add(container);
    root.updateMatrixWorld(true);
    root.userData.disposeAsset = async (): Promise<void> => {
      for (const pending of materials.values()) (await pending).dispose();
      await session.release();
    };
    return root as THREE_NS.Group & Record<string, unknown>;
  } catch (error) {
    await session.release();
    throw error;
  }
}
