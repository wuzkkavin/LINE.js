// nobrowser: HWLINEHELPER_NO_BROWSER 環境變數的判斷 (規格書 v3: 原生殼啟動引擎時不開瀏覽器)
import { test } from "node:test";
import assert from "node:assert/strict";
import { noBrowser } from "../launcher/nobrowser.mjs";

test("HWLINEHELPER_NO_BROWSER=1 時不開瀏覽器", () => {
  assert.equal(noBrowser({ HWLINEHELPER_NO_BROWSER: "1" }), true);
});

test("未設定或其他值時維持原本行為 (會開瀏覽器)", () => {
  assert.equal(noBrowser({}), false);
  assert.equal(noBrowser({ HWLINEHELPER_NO_BROWSER: "0" }), false);
  assert.equal(noBrowser({ HWLINEHELPER_NO_BROWSER: "true" }), false);
  assert.equal(noBrowser({ HWLINEHELPER_NO_BROWSER: "" }), false);
});
