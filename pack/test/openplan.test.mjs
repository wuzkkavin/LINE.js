// 啟動開頁決策測試: 未登入 (無可用 session) 要同時開登入頁與控制台, 已登入只開控制台。
// 背景: 2026-10-20 老吳實測舊版只開控制台, 新手找不到登入頁無從登入。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CORE_URL, CONSOLE_URL, hasUsableSession, planBrowserUrls } from "../launcher/openplan.mjs";
import { dataPaths, resolveDataDir } from "../launcher/paths.mjs";

function tmpPaths(files) {
  const dir = mkdtempSync(join(tmpdir(), "aibao-openplan-"));
  const paths = dataPaths(resolveDataDir({ HWLINEHELPER_HOME: dir }, "linux"));
  for (const [key, content] of Object.entries(files)) writeFileSync(paths[key], content);
  return paths;
}

test("openplan: 完全沒有 session 檔案 → 未登入, 開兩個頁面 (控制台 + 登入頁)", () => {
  const paths = tmpPaths({});
  assert.equal(hasUsableSession(paths), false);
  assert.deepEqual(planBrowserUrls({ hasSession: hasUsableSession(paths) }), [CONSOLE_URL, CORE_URL]);
});

test("openplan: session.json 只是空物件 {} (核心未登入也會建立) → 仍算未登入", () => {
  const paths = tmpPaths({ sessionFile: "{}" });
  assert.equal(hasUsableSession(paths), false);
  assert.deepEqual(planBrowserUrls({ hasSession: false }), [CONSOLE_URL, CORE_URL]);
});

test("openplan: session.json 有實際內容 → 已登入, 只開控制台", () => {
  const paths = tmpPaths({ sessionFile: JSON.stringify({ authToken: "x", savedAt: 1 }) });
  assert.equal(hasUsableSession(paths), true);
  assert.deepEqual(planBrowserUrls({ hasSession: hasUsableSession(paths) }), [CONSOLE_URL]);
});

test("openplan: 只有 Windows DPAPI 密文 session → 已登入", () => {
  const paths = tmpPaths({ sessionEncrypted: "dpapi-blob" });
  assert.equal(hasUsableSession(paths), true);
});

test("openplan: 只有 Linux AES 密文 session → 已登入", () => {
  const dir = mkdtempSync(join(tmpdir(), "aibao-openplan-"));
  const paths = { ...dataPaths(resolveDataDir({ HWLINEHELPER_HOME: dir }, "linux")), sessionAesFile: join(dir, "session.json.aes") };
  writeFileSync(paths.sessionAesFile, "aes-blob");
  assert.equal(hasUsableSession(paths), true);
});

test("openplan: session.json 是空檔案且無密文 → 未登入", () => {
  const paths = tmpPaths({ sessionFile: "" });
  assert.equal(hasUsableSession(paths), false);
});
