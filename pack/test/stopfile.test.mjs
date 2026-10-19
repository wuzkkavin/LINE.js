// stopfile: 停止訊號檔的一次性消費與殘留清除 (原生殼請引擎優雅結束的控制通道)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopFilePath, clearStopRequest, consumeStopRequest } from "../launcher/stopfile.mjs";

function tempPaths() {
  return { root: mkdtempSync(join(tmpdir(), "aibao-stopfile-")) };
}

test("沒有訊號檔時 consume 回傳 false", () => {
  assert.equal(consumeStopRequest(tempPaths()), false);
});

test("有訊號檔時 consume 回傳 true 並把檔案刪除 (只觸發一次)", () => {
  const paths = tempPaths();
  writeFileSync(stopFilePath(paths), "stop");
  assert.equal(consumeStopRequest(paths), true);
  assert.equal(existsSync(stopFilePath(paths)), false);
  assert.equal(consumeStopRequest(paths), false);
});

test("clearStopRequest 會清掉殘留訊號檔, 之後 consume 不觸發", () => {
  const paths = tempPaths();
  writeFileSync(stopFilePath(paths), "stop");
  clearStopRequest(paths);
  assert.equal(existsSync(stopFilePath(paths)), false);
  assert.equal(consumeStopRequest(paths), false);
});
