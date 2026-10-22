// 管理員通知單元測試: 設定驗證、@ 退路決策、10 分鐘節流、每日上限合併。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminEventStore, validateNotifySettings, planTargets, matchNotifyRules, NOTIFY_DAILY_CAP } from "../src/adminnotify.mjs";

test("設定驗證: keyword 規則沒填關鍵字被擋、種類錯誤被擋", () => {
  assert.equal(validateNotifySettings({ admins: [], rules: [{ kind: "keyword", keyword: "" }] }).ok, false);
  assert.equal(validateNotifySettings({ admins: [], rules: [{ kind: "nope" }] }).ok, false);
  const ok = validateNotifySettings({
    admins: [{ id: "u123", name: "老吳" }],
    rules: [{ kind: "keyword", keyword: "報價", notifyAdminIds: ["u123"], enabled: true }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.rules[0].keyword, "報價");
});

test("planTargets: 不在群/沒說過話走純文字退路, 有發言過可 @", () => {
  const admins = [{ id: "a", name: "甲" }, { id: "b", name: "乙" }, { id: "c", name: "丙" }];
  const rule = { notifyAdminIds: ["a", "b", "c"] };
  const t = planTargets({ rule, admins, presence: { a: { inChat: true, hasSpoken: true }, b: { inChat: false }, c: { inChat: true, hasSpoken: false } } });
  assert.equal(t.find((x) => x.adminId === "a").mode, "mention");
  assert.equal(t.find((x) => x.adminId === "b").mode, "plain");
  assert.match(t.find((x) => x.adminId === "b").note, /不在此群/);
  assert.equal(t.find((x) => x.adminId === "c").mode, "plain");
  // 缺 presence 資料時不誤退路
  const t2 = planTargets({ rule, admins, presence: {} });
  assert.equal(t2[0].mode, "mention");
});

test("事件紀錄: 10 分鐘內同種事件只通知一次, 之後合併計數", () => {
  const dir = mkdtempSync(join(tmpdir(), "admnev-"));
  try {
    let nowMs = Date.parse("2026-10-22T08:00:00+08:00");
    const store = new AdminEventStore({ path: join(dir, "e.json"), now: () => nowMs });
    const evt = { kind: "scam", chatId: "c1", detail: "高風險詐騙" };
    assert.equal(store.record(evt).action, "notify");
    nowMs += 5 * 60_000;
    const second = store.record(evt);
    assert.equal(second.action, "record");
    assert.equal(second.reason, "throttled");
    assert.equal(second.event.mergedCount, 1);
    // 不同聊天室不受節流
    assert.equal(store.record({ ...evt, chatId: "c2" }).action, "notify");
    // 10 分鐘過後可再通知
    nowMs += 11 * 60_000;
    assert.equal(store.record(evt).action, "notify");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("事件紀錄: 每日通知達上限後只寫紀錄", () => {
  const dir = mkdtempSync(join(tmpdir(), "admnev-"));
  try {
    let nowMs = Date.parse("2026-10-22T00:00:00+08:00");
    const store = new AdminEventStore({ path: join(dir, "e.json"), now: () => nowMs, throttleMs: 0 });
    for (let i = 0; i < NOTIFY_DAILY_CAP; i++) {
      assert.equal(store.record({ kind: "unanswered", chatId: "c" + i }).action, "notify");
      nowMs += 1000;
    }
    const over = store.record({ kind: "unanswered", chatId: "cx" });
    assert.equal(over.action, "record");
    assert.equal(over.reason, "daily-cap");
    assert.match(over.event.note, /上限/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("matchNotifyRules(第四階段): 只挑啟用且符合的規則, 關鍵字要真的出現", () => {
  const notify = {
    admins: [{ id: "a", name: "甲" }],
    rules: [
      { kind: "keyword", keyword: "報價", enabled: true, notifyAdminIds: ["a"] },
      { kind: "keyword", keyword: "客訴", enabled: false, notifyAdminIds: ["a"] },
      { kind: "scam", enabled: true, notifyAdminIds: ["a"] },
    ],
  };
  assert.equal(matchNotifyRules(notify, "keyword", { text: "請問報價多少" }).length, 1);
  assert.equal(matchNotifyRules(notify, "keyword", { text: "我要客訴" }).length, 0); // 停用的不算
  assert.equal(matchNotifyRules(notify, "keyword", { text: "午餐吃什麼" }).length, 0);
  assert.equal(matchNotifyRules(notify, "scam", {}).length, 1);
  assert.equal(matchNotifyRules(notify, "unanswered", {}).length, 0);
});

test("事件紀錄(第四階段): markSent 寫回送出結果, pendingNotify 只列還沒送的", () => {
  const dir = mkdtempSync(join(tmpdir(), "admnev-"));
  try {
    const store = new AdminEventStore({ path: join(dir, "e.json") });
    const r = store.record({ kind: "scam", chatId: "c1", message: "詐騙警報：…" });
    assert.equal(r.action, "notify");
    assert.equal(r.event.message, "詐騙警報：…");
    assert.equal(store.pendingNotify().length, 1);
    const m = store.markSent(r.event.id, false, "@ 沒有送出去，已改用寫名字的方式通知");
    assert.equal(m.ok, true);
    assert.equal(m.event.sentOk, false);
    assert.match(m.event.note, /寫名字/);
    assert.equal(store.pendingNotify().length, 0);
    assert.equal(store.markSent("nope", true).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
