// 教材庫單元測試: 存放/列出/讀回、檔名安全、大小上限。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaterialsStore, MATERIAL_MAX_BYTES } from "../src/materials.mjs";

test("教材庫: 存入後可列出並讀回相同內容", () => {
  const dir = mkdtempSync(join(tmpdir(), "materials-"));
  try {
    const store = new MaterialsStore({ dir: join(dir, "materials") });
    assert.deepEqual(store.list(), []);
    const r = store.save("步驟圖.png", Buffer.from([1, 2, 3, 4]));
    assert.equal(r.ok, true);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].name, "步驟圖.png");
    assert.equal(store.list()[0].sizeBytes, 4);
    assert.deepEqual([...store.read("步驟圖.png")], [1, 2, 3, 4]);
    assert.equal(store.read("不存在.png"), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("教材庫: 危險檔名與超限被擋", () => {
  const dir = mkdtempSync(join(tmpdir(), "materials-"));
  try {
    const store = new MaterialsStore({ dir: join(dir, "materials") });
    assert.equal(store.save("../evil.png", Buffer.from([1])).ok, false);
    assert.equal(store.save("a/b.png", Buffer.from([1])).ok, false);
    assert.equal(store.save("", Buffer.from([1])).ok, false);
    assert.equal(store.save("big.png", Buffer.alloc(MATERIAL_MAX_BYTES + 1)).ok, false);
    assert.equal(store.save("empty.png", Buffer.alloc(0)).ok, false);
    assert.deepEqual(store.list(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
