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

test("事件紀錄(修復): 被合併的事件在節流窗過後補送一則彙總, 不再石沉大海", () => {
  const dir = mkdtempSync(join(tmpdir(), "admnev-"));
  try {
    let nowMs = Date.parse("2026-10-22T13:53:00+08:00");
    const store = new AdminEventStore({ path: join(dir, "e.json"), now: () => nowMs });
    const evt = { kind: "keyword", chatId: "c1", chatName: "公司群", detail: "有人提到「管理員」", message: "有人提到關鍵字：…" };
    const first = store.record(evt);
    assert.equal(first.action, "notify");
    store.markSent(first.event.id, true);
    nowMs += 1 * 60_000; // 13:54
    assert.equal(store.record(evt).reason, "throttled");
    nowMs += 1 * 60_000; // 13:55
    const third = store.record(evt);
    assert.equal(third.reason, "throttled");
    assert.equal(third.event.mergedCount, 2);
    // 還在靜默期內 (最後一筆合併未滿 10 分鐘): 不急著彙總
    nowMs += 5 * 60_000;
    assert.equal(store.collectDueSummaries().length, 0);
    // 靜默滿 10 分鐘: 產生一則彙總, 進待送清單; 原事件合併數歸零並記已補送
    nowMs += 6 * 60_000;
    const made = store.collectDueSummaries();
    assert.equal(made.length, 1);
    assert.equal(made[0].isSummary, true);
    assert.equal(made[0].summaryOf, first.event.id);
    assert.match(made[0].message, /另外還有 2 則/);
    assert.equal(store.pendingNotify().some((e) => e.id === made[0].id), true);
    const orig = store.list().find((e) => e.id === first.event.id);
    assert.equal(orig.mergedCount, 0);
    assert.equal(orig.mergedTotal, 2);
    assert.ok(orig.summarySentAt);
    // 不重複產生
    assert.equal(store.collectDueSummaries().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("事件紀錄(修復): 第一筆送失敗不當節流錨點, 窗內下一筆仍可通知", () => {
  const dir = mkdtempSync(join(tmpdir(), "admnev-"));
  try {
    let nowMs = Date.parse("2026-10-22T13:53:00+08:00");
    const store = new AdminEventStore({ path: join(dir, "e.json"), now: () => nowMs });
    const evt = { kind: "keyword", chatId: "c1", detail: "有人提到「管理員」" };
    const first = store.record(evt);
    assert.equal(first.action, "notify");
    store.markSent(first.event.id, false, "通知送不出去");
    nowMs += 1 * 60_000;
    // 舊版會被 throttled 合併進送失敗的那一筆; 修復後重新通知
    assert.equal(store.record(evt).action, "notify");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("事件紀錄(修復): 送失敗的通知不吃每日額度", () => {
  const dir = mkdtempSync(join(tmpdir(), "admnev-"));
  try {
    let nowMs = Date.parse("2026-10-22T00:00:00+08:00");
    const store = new AdminEventStore({ path: join(dir, "e.json"), now: () => nowMs, throttleMs: 0 });
    for (let i = 0; i < NOTIFY_DAILY_CAP; i++) {
      const r = store.record({ kind: "unanswered", chatId: "c" + i });
      assert.equal(r.action, "notify");
      store.markSent(r.event.id, false, "送不出去");
      nowMs += 1000;
    }
    // 20 筆全送失敗: 額度不應被吃光, 第 21 筆仍可通知
    assert.equal(store.record({ kind: "unanswered", chatId: "cx" }).action, "notify");
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
