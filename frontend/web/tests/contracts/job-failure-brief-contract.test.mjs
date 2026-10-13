/** 列表失败简报的字段名，两端必须一致。
 *
 * 后端 `JobFailureBriefView` 是 serde 直接序列化的（没有 rename），所以 JSON 的键名
 * **就是** Rust 的字段名；前端 `JobFailureBrief` 按这些键硬读。
 *
 * 只改一边时 tsc 不报 —— 那些字段在 TS 侧是可选的，取值处还有 `as` 强转
 * （`(ocrJob as { failure?: JobFailureBrief })?.failure`）。两边单测也照样全绿：
 * Rust 那条断言的是作者手写的夹具，前端那条喂的是作者手写的对象。而用户看到的是
 * 「根因」那一行、「上游 · mineru」那半行**整行消失**；`retryable` 一漂，不可重试的
 * 失败会开始怂恿人去点重试。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { code, readSource } from "../helpers/source-text.mjs";

const read = (rel) => readSource(rel, import.meta.url);

/** 取一个结构体 / 类型字面量的定义体。
 *
 * 找不到起点时**必须红**，不能静默返回空串 —— 空集合上的 deepEqual 是恒等式。 */
function definitionBody(source, startMarker, endMarker) {
  const from = source.indexOf(startMarker);
  assert.notEqual(from, -1, `找不到 ${startMarker} —— 它被改名或搬走了，这条契约没在守任何东西`);
  const rest = source.slice(from + startMarker.length);
  const to = rest.indexOf(endMarker);
  assert.notEqual(to, -1, `${startMarker} 的定义没有收尾`);
  return rest.slice(0, to);
}

const TS_SOURCE = read("../../src/platform/contracts/library-payloads.ts");

const tsFields = () => [
  ...definitionBody(TS_SOURCE, "export type JobFailureBrief = {", "\n};")
    .matchAll(/^\s{2}([a-z_]+)\??:/gm),
].map((m) => m[1]);

const rustFields = () => {
  const rust = definitionBody(
    read("../../../../backend/packages/retain-core/src/models/view/job_types.rs"),
    "pub struct JobFailureBriefView {",
    "\n}",
  );
  const fields = [...rust.matchAll(/^\s*pub ([a-z_]+):/gm)].map((m) => m[1]);
  // 抽取失效时要红，不能在空集合上恒真。
  assert.ok(fields.length >= 7, `只解析出 ${fields.length} 个 Rust 字段，解析逻辑失效了`);
  return fields;
};

test("列表失败简报的字段名两端一致 —— 漂一个，卡片上就空一行", () => {
  assert.deepEqual(
    [...tsFields()].sort(),
    [...rustFields()].sort(),
    "两端字段名不一致 —— 多出来的那个永远是 undefined，少掉的那个永远画不出来",
  );
});
