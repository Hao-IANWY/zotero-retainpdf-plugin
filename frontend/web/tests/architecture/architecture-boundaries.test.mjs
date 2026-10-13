// 源码分层边界门禁：依赖方向、样式归属、配置常量来源、各域只经 port 读状态。
// React 迁移防回弹与包入口两块已拆到 react-migration-boundaries.test.mjs；
// 两边共用的取文件工具在 helpers/boundary-scan.mjs。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  relativeToProject,
  scanRoot,
  scanRoots,
  walkFiles,
} from "./helpers/boundary-scan.mjs";

const PROJECT_ROOT = process.cwd();
const REPOSITORY_ROOT = join(PROJECT_ROOT, "../..");
const JS_ROOT = join(PROJECT_ROOT, "src/js");
const PLATFORM_ROOT = join(PROJECT_ROOT, "src/platform");
const DOMAIN_JOB_SOURCE_ROOT = join(PROJECT_ROOT, "../../frontend/packages/domain/src/job");
// FEATURE_ROOT（src/js/features）已在批次 5B 的 B6/B7 拆空删除：型别归
// platform/contracts、store 归 app/home/state、idle 视图归 app/home/composition、
// resetStatusDetailRuntimeView 归 features/job-detail。以它为扫描根的四条规则
// 见下方逐条说明（两条重定向到新位置，四条删除并注明被谁接管）。
const BOOTSTRAP_ROOT = join(PROJECT_ROOT, "src/app/bootstrap");
// 新世界功能层（按功能重组后的 src/features/*），承接原 FEATURE_ROOT 仍然成立的规则。
const FEATURE_LAYER_ROOT = join(PROJECT_ROOT, "src/features");
const SOURCE_ROOTS = {
  api: join(PLATFORM_ROOT, "api/mocks"),
  bootstrap: BOOTSTRAP_ROOT,
  config: join(PLATFORM_ROOT, "config"),
  contracts: join(PLATFORM_ROOT, "contracts"),
  job: DOMAIN_JOB_SOURCE_ROOT,
  jobMirror: join(JS_ROOT, "job"),
  jobDetail: join(PROJECT_ROOT, "src/features/job-detail/domain/page"),
  jobStatus: join(JS_ROOT, "job-status"),
  state: join(JS_ROOT, "state"),
  ui: join(JS_ROOT, "ui"),
  utils: join(PLATFORM_ROOT, "utils"),
};
const APP_ENTRYPOINTS = [
  join(PROJECT_ROOT, "app.js"),
  join(PROJECT_ROOT, "app-bundle-entry.js"),
];

const WEBAWESOME_USAGE_PATTERN = /@awesome\.me\/webawesome|<wa-|wa-(?:button|dialog|progress|badge|card|progress-ring|progress-bar)\b|WebAwesome|Web Awesome/;
const SHARED_DIALOG_SHELL_SELECTOR_PATTERN = /^\s*\.(?:app-(?:dialog|confirm|floating)-[\w-]+|desktop-dialog|desktop-shell|desktop-head|desktop-body|dialog-close-btn)(?:\s|[,{:#.])/m;
const RAW_RADIX_DIALOG_IMPORT_PATTERN = /import\s*\{[^}]*\bDialog\b[^}]*\}\s*from\s*["'](?:@radix-ui\/react-dialog|radix-ui)["']/s;
const BROWSER_BLOCKING_DIALOG_PATTERN = /\b(?:window\.|globalThis\.)?(?:alert|confirm|prompt)\s*\(/;
const APP_UPDATE_SELECTOR_PATTERN = /^\s*\.app-update-[\w-]+(?:\s|[,{:#.])/m;
const LIBRARY_SHELL_SELECTOR_PATTERN = /^\s*(?:\.(?:page|app-shell|topbar|app-shell-header|library-[\w-]+|home-action-btn|brand-[\w-]+|hero(?:-[\w-]+)?)(?:\s|[,{:#.])|#recent-jobs-list\.library-grid\b|\.recent-jobs-more-row\s+#load-more-jobs-btn\b)/m;
const API_PREFIX_FROM_ROOT_CONSTANTS_PATTERN = /import\s*{[^}]*API_PREFIX[^}]*}\s*from\s+["'](?:\.\.\/)+constants\.js["']/s;

const MODEL_CONSTANTS_FROM_ROOT_PATTERN = /import\s*{[^}]*(?:DEFAULT_MODEL|DEFAULT_BASE_URL|DEFAULT_MODEL_VERSION)[^}]*}\s*from\s+["'](?:\.\.\/)+constants\.js["']/s;
const STORAGE_KEYS_FROM_ROOT_PATTERN = /import\s*{[^}]*(?:BROWSER_CONFIG_STORAGE_KEY|DEVELOPER_CONFIG_STORAGE_KEY)[^}]*}\s*from\s+["'](?:\.\.\/)+constants\.js["']/s;
const WORKFLOW_DEFAULTS_FROM_ROOT_PATTERN = /import\s*{[^}]*(?:DEFAULT_MODE|DEFAULT_LANGUAGE|DEFAULT_RULE_PROFILE|DEFAULT_RENDER_MODE|DEFAULT_TYPST_FONT_FAMILY|DEFAULT_PDF_COMPRESS_DPI|DEFAULT_TRANSLATED_PDF_NAME|DEFAULT_BODY_FONT_SIZE_FACTOR|DEFAULT_BODY_LEADING_FACTOR|DEFAULT_INNER_BBOX_SHRINK_X|DEFAULT_INNER_BBOX_SHRINK_Y|DEFAULT_INNER_BBOX_DENSE_SHRINK_X|DEFAULT_INNER_BBOX_DENSE_SHRINK_Y|DEFAULT_FONT_UNIFY_MODE|DEFAULT_WORKERS|DEFAULT_BATCH_SIZE|DEFAULT_CLASSIFY_BATCH_SIZE|DEFAULT_COMPILE_WORKERS|DEFAULT_TIMEOUT_SECONDS)[^}]*}\s*from\s+["'](?:\.\.\/)+constants\.js["']/s;
const BOOTSTRAP_EXTERNAL_IMPORT_PATTERN = /from\s+["']\.\.\/(?:features|ui|api|state)\/|from\s+["']\.\.\/(?:config|constants)\.js["']/;
// Phase 3 home cutover 删掉了绝大部分 src/js/bootstrap/(227 个手工 DI 端口文件里的
// 226 个);现存文件只允许承担明确的 package/reader iframe 依赖注入边界。以下两份
// 清单曾各有 30~130 个条目对应
// 已删除文件——Phase 4 收紧为只保留仍然存在的条目,新文件若再落进 bootstrap/ 会被
// 下面两条门禁测试正确拦下,强制显式决定是否加回允许清单。
const BOOTSTRAP_GROUPED_PORT_FILES = [];
const BOOTSTRAP_GROUPED_PORT_DISCOVERY_ALLOWLIST = new Set([]);

const BOOTSTRAP_EXTERNAL_IMPORT_ALLOWLIST = new Set([
  "job-domain-adapters.ts",
]);

/** 源文件已迁 TS 后，测试里仍可写 foo.js，实际读 foo.ts */
function resolveSourcePath(filePath) {
  if (existsSync(filePath)) {
    return filePath;
  }
  if (filePath.endsWith(".js")) {
    const asTs = `${filePath.slice(0, -3)}.ts`;
    if (existsSync(asTs)) return asTs;
    const asTsx = `${filePath.slice(0, -3)}.tsx`;
    if (existsSync(asTsx)) return asTsx;
  }
  if (filePath.endsWith(".jsx")) {
    const asTsx = `${filePath.slice(0, -4)}.tsx`;
    if (existsSync(asTsx)) return asTsx;
  }
  return filePath;
}

function allPathsUnder(root) {
  const pending = [root];
  const paths = [];
  while (pending.length > 0) {
    const current = pending.pop();
    paths.push(current);
    if (!statSync(current).isDirectory()) {
      continue;
    }
    for (const entry of readdirSync(current)) {
      pending.push(join(current, entry));
    }
  }
  return paths.sort();
}

function readSource(filePath) {
  return readFileSync(resolveSourcePath(filePath), "utf8");
}

const IS_TS_OR_TSX = (filePath) => /\.(?:ts|tsx)$/.test(filePath);

/** 去掉 `import type` 再匹配——TS 类型导入不构成运行时对 view 层的依赖 */
function sourceWithoutTypeImports(source) {
  return source
    .replace(/import\s+type\s+[\s\S]*?from\s+["'][^"']+["']\s*;?/g, "")
    .replace(/import\s*\{[^}]*\}\s*from\s+["'][^"']+["']\s*;?/g, (block) => {
      // 保留值导入；若整行只有 type 已在上一步处理
      return block;
    });
}

function findMatchingImports(files, pattern) {
  return files
    .filter((file) => pattern.test(sourceWithoutTypeImports(readSource(file))))
    .map((file) => relativeToProject(file));
}

function findMatchingSources(files, pattern) {
  return files
    .filter((file) => pattern.test(readSource(file)))
    .map((file) => relativeToProject(file));
}

test("source tree does not contain notebook checkpoint artifacts", () => {
  const offenders = allPathsUnder(join(PROJECT_ROOT, "src"))
    .filter((filePath) => filePath.split("/").includes(".ipynb_checkpoints"))
    .map((filePath) => relativeToProject(filePath));

  assert.deepEqual(offenders, []);
});

test("npm workspaces use the repository root lockfile", () => {
  const nestedLockfiles = [
    join(REPOSITORY_ROOT, "frontend/desktop/package-lock.json"),
    join(REPOSITORY_ROOT, "frontend/web/package-lock.json"),
    join(REPOSITORY_ROOT, "frontend/web-react/package-lock.json"),
    join(REPOSITORY_ROOT, "frontend/packages/reader/package-lock.json"),
  ].filter((filePath) => existsSync(filePath));

  assert.equal(existsSync(join(REPOSITORY_ROOT, "package-lock.json")), true);
  assert.deepEqual(nestedLockfiles, []);
});

test("runtime frontend does not depend on WebAwesome", () => {
  const runtimeSources = [
    ...APP_ENTRYPOINTS,
    join(PROJECT_ROOT, "package.json"),
    join(REPOSITORY_ROOT, "package-lock.json"),
    ...walkFiles(JS_ROOT),
    ...allPathsUnder(join(PROJECT_ROOT, "src/styles")).filter((filePath) => filePath.endsWith(".css")),
  ].filter((filePath) => existsSync(filePath));
  const offenders = findMatchingSources(runtimeSources, WEBAWESOME_USAGE_PATTERN);

  assert.deepEqual(offenders, []);
});




test("shared dialog shell styles stay in dialog-shell css", () => {
  const styleSources = allPathsUnder(join(PROJECT_ROOT, "src/styles"))
    .filter((filePath) => filePath.endsWith(".css"))
    .filter((filePath) => filePath !== join(PROJECT_ROOT, "src/styles/dialog-shell.css"));
  const offenders = findMatchingSources(styleSources, SHARED_DIALOG_SHELL_SELECTOR_PATTERN);

  assert.deepEqual(offenders, []);
});

test("application dialogs use the shared dialog component boundary", () => {
  const sharedDialog = join(PROJECT_ROOT, "src/ui/components/dialog.tsx");
  // 唯一允许直连 Radix Dialog 的文件。路径写错就等于把豁免发给了一个不存在的文件，
  // 门禁会反过来把真正的共享组件判成违规——先断言它在，失败信息才指得准。
  assert.ok(existsSync(sharedDialog), `共享 dialog 组件不存在，门禁已失效: ${relativeToProject(sharedDialog)}`);
  const offenders = findMatchingSources(
    walkFiles(join(PROJECT_ROOT, "src")).filter((filePath) => filePath !== sharedDialog),
    RAW_RADIX_DIALOG_IMPORT_PATTERN,
  );

  assert.deepEqual(offenders, []);
});

test("production React UI does not use browser blocking dialogs", () => {
  const offenders = findMatchingSources(
    scanRoots([
      join(PROJECT_ROOT, "src/app"),
      join(PROJECT_ROOT, "src/ui"),
      join(PROJECT_ROOT, "src/features"),
    ]),
    BROWSER_BLOCKING_DIALOG_PATTERN,
  );

  assert.deepEqual(offenders, []);
});

test("app update styles stay in app-update css", () => {
  const styleSources = allPathsUnder(join(PROJECT_ROOT, "src/styles"))
    .filter((filePath) => filePath.endsWith(".css"))
    .filter((filePath) => filePath !== join(PROJECT_ROOT, "src/styles/pages/home/app-update.css"));
  const offenders = findMatchingSources(styleSources, APP_UPDATE_SELECTOR_PATTERN);

  assert.deepEqual(offenders, []);
});

test("library shell styles stay in library-shell css", () => {
  const styleSources = allPathsUnder(join(PROJECT_ROOT, "src/styles"))
    .filter((filePath) => filePath.endsWith(".css"))
    .filter((filePath) => filePath !== join(PROJECT_ROOT, "src/styles/pages/home/library-shell.css"));
  const offenders = findMatchingSources(styleSources, LIBRARY_SHELL_SELECTOR_PATTERN);

  assert.deepEqual(offenders, []);
});

// 删：「feature modules import local view.js only through explicit view boundary ports」。
// 旧世界的 features/*/view.js 视图层已随各功能迁移全部删除（src 下已无 view.ts/js），
// 且同一模式由下方「React 新世界禁止 import 旧视图层」的
// `features/*/view.js(旧 DOM 视图)` 一条接管，扫描根 src/{app,ui,features} 仍存在
// 且有存在性断言，不会静默变绿。

// 删：「feature modules import legacy global state only through state boundary ports」。
// 由「React 新世界禁止 import 旧视图层」的 `src/js/state/store.js(全局状态)` 一条
// 接管，且更严——那条只留 app/desktop/bootstrap.ts 一个豁免（有只减不增的长度断言），
// 不像这里按 *-state.ts 文件名整片放行。

// 删：「feature modules do not import default ui adapters directly」。
// 它拦的是旧 src/js/ui 适配层，该目录已整体删除（SOURCE_ROOTS.ui 现在只用于
// existsSync 反向断言），被禁目标本身不存在。且 FEATURE_UI_IMPORT_PATTERN 是
// `(../)+ui/`，若改指 src/features 会把新世界合法的 `../../../ui/hooks/*`
// （src/ui，A7 之后 React 侧共用层）误判成违规——不能重定向，只能删。

// 删：「feature modules receive upload defaults through ports」。
// FEATURE_UPLOAD_CONSTANTS_IMPORT_PATTERN 是 `(../)+config/upload-constants.js`，
// 指旧 src/js/config——该目录已迁 src/platform/config 并删除，相对路径在新树里
// 解析不到任何东西。现网 upload-constants 的唯一消费方是
// app/home/composition/external/config.ts（装配层转出，本就是允许的），
// 规则已无可拦对象。

// 删：「root compatibility barrels are removed」。它断言 src/js/{config,constants,dom,
// job,main,state,templates}.js 不存在——react-migration-boundaries.test.mjs 的「已删除的
// 旧目录不得复活」已断言整个 src/js 不存在，这七个路径被它严格蕴含，两条永远同红同绿。

test("job artifact helpers read runtime and upload state through artifact runtime port", () => {
  const artifactsSource = readSource(join(SOURCE_ROOTS.job, "artifacts.js"));
  const runtimePortSource = readSource(join(SOURCE_ROOTS.job, "artifact-runtime-port.js"));

  assert.equal(
    artifactsSource.includes("../features/job-runtime/current-job-state.js"),
    false,
  );
  assert.equal(
    artifactsSource.includes("../features/job-runtime/secondary-resource-cache.js"),
    false,
  );
  assert.equal(
    artifactsSource.includes("../state/upload-state.js"),
    false,
  );
  assert.match(artifactsSource, /artifact-runtime-port\.js/);
  assert.match(runtimePortSource, /createArtifactRuntimePort/);
  assert.match(runtimePortSource, /defaultArtifactRuntimePort/);
  assert.equal(runtimePortSource.includes("../ui/"), false);
  assert.equal(runtimePortSource.includes("../features/job-runtime/"), false);
  assert.equal(runtimePortSource.includes("../state/"), false);
  assert.equal(existsSync(join(SOURCE_ROOTS.ui, "default-artifact-runtime-port.js")), false);
});

test("job layer does not keep ui presenter compatibility facades", () => {
  assert.equal(existsSync(join(SOURCE_ROOTS.job, "elapsed-renderer.js")), false);
  assert.equal(existsSync(join(SOURCE_ROOTS.job, "workflow-visibility.js")), false);
});

test("job helpers keep job-runtime feature access behind explicit runtime ports", () => {
  const offenders = walkFiles(SOURCE_ROOTS.job)
    .map((file) => relative(SOURCE_ROOTS.job, file))
    .filter((file) => readSource(join(SOURCE_ROOTS.job, file)).includes("../features/job-runtime/"));

  assert.deepEqual(offenders, []);
});


test("source modules read API prefix from config api constants", () => {
  // SOURCE_ROOTS.reader (src/js/reader) 已在更早的迁移中删除，留在这里只贡献 0 个
  // 文件、让门禁半哑（A0 加固时发现）。移除该根，其余三根逐个校验存在且非空。
  const offenders = findMatchingImports(scanRoots([
    SOURCE_ROOTS.api,
    SOURCE_ROOTS.bootstrap,
    SOURCE_ROOTS.jobDetail,
  ]), API_PREFIX_FROM_ROOT_CONSTANTS_PATTERN);

  assert.deepEqual(offenders, []);
});

test("source modules read model defaults from config model constants", () => {
  // SOURCE_ROOTS.features（src/js/features）已删除：scanRoot 会因扫描根不存在
  // 直接失败。这里照 SOURCE_ROOTS.reader 的先例摘掉死根而不替换——本规则拦的是
  // 根 barrel `(../)+constants.js`，而 src/js/constants.js 已由
  // 「root compatibility barrels are removed」断言不存在，换任何新根都恒不命中。
  const offenders = findMatchingImports(scanRoots([
    SOURCE_ROOTS.bootstrap,
    SOURCE_ROOTS.config,
  ]), MODEL_CONSTANTS_FROM_ROOT_PATTERN);

  assert.deepEqual(offenders, []);
});

test("source modules read storage keys from config storage keys", () => {
  const offenders = findMatchingImports(
    scanRoot(SOURCE_ROOTS.config),
    STORAGE_KEYS_FROM_ROOT_PATTERN,
  );

  assert.deepEqual(offenders, []);
});

test("source modules read workflow defaults from config workflow defaults", () => {
  // 同上：摘掉已删除的 SOURCE_ROOTS.features。顺手把 filesUnder 换成 scanRoot——
  // filesUnder 对不存在的根静默返回 []，正是本文件反复防的「静默变绿」。
  const offenders = findMatchingImports(
    scanRoot(SOURCE_ROOTS.bootstrap),
    WORKFLOW_DEFAULTS_FROM_ROOT_PATTERN,
  );

  assert.deepEqual(offenders, []);
});

test("bootstrap external imports stay isolated in explicit leaf ports", () => {
  const offenders = walkFiles(BOOTSTRAP_ROOT)
    .filter((file) => BOOTSTRAP_EXTERNAL_IMPORT_PATTERN.test(readSource(file)))
    .map((file) => relative(BOOTSTRAP_ROOT, file))
    .filter((file) => !BOOTSTRAP_EXTERNAL_IMPORT_ALLOWLIST.has(file));

  assert.deepEqual(offenders, []);
});

test("bootstrap grouped port list covers grouped port files", () => {
  const groupedPortSet = new Set(BOOTSTRAP_GROUPED_PORT_FILES);
  const discovered = walkFiles(BOOTSTRAP_ROOT)
    .map((file) => relative(BOOTSTRAP_ROOT, file))
    .filter((file) => /(?:-ports|mount-ports|feature-controllers-port)\.(?:js|ts)$/.test(file))
    .filter((file) => !BOOTSTRAP_GROUPED_PORT_DISCOVERY_ALLOWLIST.has(file));
  const missing = discovered.filter((file) => !groupedPortSet.has(file));

  assert.deepEqual(missing, []);
});

test("runtime source paths avoid the legacy hidden credential facade", () => {
  const bootstrapFiles = walkFiles(BOOTSTRAP_ROOT);
  // credentials 功能已随网页端收缩删除：扫描根从已删除的 src/js/features
  // 改指新功能层，规则本身（谁都不许依赖隐藏凭据门面）仍然成立。
  const featureFiles = scanRoot(FEATURE_LAYER_ROOT);
  for (const filePath of [...bootstrapFiles, ...featureFiles]) {
    const source = readFileSync(filePath, "utf8");
    assert.equal(
      source.includes("features/credentials/hidden-inputs.js")
        || source.includes("../credentials/hidden-inputs.js")
        || source.includes("./hidden-inputs.js"),
      false,
      `${filePath} should not depend on hidden-inputs.js`,
    );
  }
});


test("job domains are consumed from packages instead of web mirrors", () => {
  assert.deepEqual(
    walkFiles(SOURCE_ROOTS.jobMirror),
    [],
    "frontend/web/src/js/job must not return; use @retainpdf/domain/job",
  );
  assert.deepEqual(
    walkFiles(SOURCE_ROOTS.jobStatus),
    [],
    "frontend/web/src/js/job-status must not return; use @retainpdf/domain/job-status",
  );

  // 原先还断言装配工厂消费包内 job-status；装配层已随主页删除，消费点只剩
  // 存活页面（task-center/job-detail），由 react-migration 门禁的包入口断言覆盖。
});

// 删：「ui layer does not keep stage action compatibility helper」。src/js/ui/stage-actions.js
// 同样被「已删除的旧目录不得复活」（src/js 整体不得存在）严格蕴含。



