// 待發清單 (outbox) 單元測試: 驗證是消費者可見規則——大小/字數上限、排程算時間、逐項成敗、過期不自動發。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutboxStore, validateOutboxInput, computeNextRun, flattenItems, OUTBOX_TEXT_MAX } from "../src/outbox.mjs";

const base = { chatId: "c123", chatName: "公司學習群", items: { text: "本週教材請先看" }, schedule: { mode: "now" } };

test("驗證: 文字超限、圖片/檔案超 10MB、沒選群組或沒內容都被擋下", () => {
  assert.equal(validateOutboxInput({ ...base, items: { text: "x".repeat(OUTBOX_TEXT_MAX + 1) } }).ok, false);
  assert.equal(validateOutboxInput({ ...base, items: { images: [{ name: "a.png", sizeBytes: 11 * 1024 * 1024 }] } }).ok, false);
  assert.equal(validateOutboxInput({ ...base, items: { files: [{ name: "a.pdf", sizeBytes: 11 * 1024 * 1024 }] } }).ok, false);
  assert.equal(validateOutboxInput({ ...base, chatId: "" }).ok, false);
  assert.equal(validateOutboxInput({ ...base, items: {} }).ok, false);
  // 檔案可多選、文字可搭配
  const ok = validateOutboxInput({ ...base, items: { text: "hi", files: [{ name: "1.pdf", sizeBytes: 100 }, { name: "2.pdf", sizeBytes: 200 }] } });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.items.files.length, 2);
});

test("computeNextRun: 每日/每週/每月與結束條件", () => {
  // 排程吃本機時間 (產品跑在老吳的台灣電腦); 預期值用本機 Date 建構, 不寫死時區, UTC 的 CI 也能跑。
  const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo, d, h, mi).getTime();
  const from = local(2026, 9, 22, 8); // 2026-10-22 週四早上 (本機)
  const daily = { mode: "repeat", repeat: { kind: "same", cycle: "daily", time: "09:00", weekdays: [], monthDay: 1, endDate: "", maxCount: 0 } };
  assert.equal(computeNextRun(daily, from), local(2026, 9, 22, 9));
  assert.equal(computeNextRun(daily, local(2026, 9, 22, 9, 30)), local(2026, 9, 23, 9));
  const weeklyMon = { mode: "repeat", repeat: { ...daily.repeat, cycle: "weekly", weekdays: [1] } };
  assert.equal(computeNextRun(weeklyMon, from), local(2026, 9, 26, 9));
  const monthly15 = { mode: "repeat", repeat: { ...daily.repeat, cycle: "monthly", monthDay: 15 } };
  assert.equal(computeNextRun(monthly15, from), local(2026, 10, 15, 9));
  // 次數到上限 -> 沒有下一次
  assert.equal(computeNextRun(daily, from, { sentCount: 3 }), local(2026, 9, 22, 9)); // maxCount=0 表示不限
  assert.equal(computeNextRun({ ...daily, repeat: { ...daily.repeat, maxCount: 3 } }, from, { sentCount: 3 }), null);
  // 結束日期過了 -> 沒有下一次
  assert.equal(computeNextRun({ ...daily, repeat: { ...daily.repeat, endDate: "2026-10-21" } }, from), null);
});

test("store: 建立/修改/取消/逐項結果/過期標記/落盤重讀", () => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-"));
  try {
    let nowMs = Date.parse("2026-10-22T08:00:00+08:00");
    const path = join(dir, "outbox.json");
    const store = new OutboxStore({ path, now: () => nowMs });
    const created = store.create({ ...base, items: { text: "hi", files: [{ name: "a.pdf", sizeBytes: 10 }] }, schedule: { mode: "once", at: "2026-10-22T09:00:00+08:00" } });
    assert.equal(created.ok, true);
    const id = created.entry.id;
    assert.equal(flattenItems(created.entry).length, 2);
    // 時間還沒到不算過期; 時間過了標 overdue (不自動發)
    assert.equal(store.list()[0].overdue, false);
    nowMs = Date.parse("2026-10-22T10:00:00+08:00");
    assert.equal(store.list()[0].overdue, true);
    // 逐項結果: 文字成功、檔案失敗 -> partial
    const r = store.recordResult(id, [{ ok: true }, { ok: false, note: "上傳失敗" }]);
    assert.equal(r.entry.status, "partial");
    // 已處理完不能再改
    assert.equal(store.update(id, { items: { text: "x" } }).ok, false);
    // 取消另一筆
    const c2 = store.create(base);
    assert.equal(store.cancel(c2.entry.id).entry.status, "cancelled");
    // 落盤重讀還在
    const store2 = new OutboxStore({ path, now: () => nowMs });
    assert.equal(store2.list().length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store: 頻率系列發完自動停", () => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-"));
  try {
    let nowMs = Date.parse("2026-10-22T08:00:00+08:00");
    const store = new OutboxStore({ path: join(dir, "o.json"), now: () => nowMs });
    const created = store.create({
      chatId: "c1", items: { text: "第1課" },
      schedule: { mode: "repeat", repeat: { kind: "series", cycle: "daily", time: "09:00" } },
      seriesItems: [{ text: "第1課" }, { text: "第2課" }],
    });
    assert.equal(created.ok, true);
    const id = created.entry.id;
    nowMs += 3600_000;
    store.recordResult(id, [{ ok: true }]);
    assert.equal(store.list().find((e) => e.id === id).status, "pending"); // 還有第2課
    nowMs += 3600_000;
    const r2 = store.recordResult(id, [{ ok: true }]);
    assert.equal(r2.entry.status, "done"); // 發完自動停
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store(第三階段): 順延只改下一次時間; 跳過錯過的重複發不補發; 重送結果不推進系列", () => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-"));
  try {
    let nowMs = Date.parse("2026-10-22T08:00:00+08:00");
    const store = new OutboxStore({ path: join(dir, "o.json"), now: () => nowMs });
    // 順延: 有人剛進群的交接窗口
    const c1 = store.create({ ...base, schedule: { mode: "once", at: "2026-10-22T08:05:00+08:00" } });
    const d = store.defer(c1.entry.id, nowMs + 180_000, "有人剛進群組, 先等鑰匙交接完成再發");
    assert.equal(d.ok, true);
    assert.equal(d.entry.nextRunAt, nowMs + 180_000);
    assert.match(d.entry.history.at(-1).note, /鑰匙交接/);
    // 跳過: 每日重複, 程式沒開錯過今天這次 -> 直接算明天, 不補發
    const c2 = store.create({ chatId: "c1", items: { text: "每日提醒" }, schedule: { mode: "repeat", repeat: { kind: "same", cycle: "daily", time: "07:00" } } });
    const sk = store.skipMissed(c2.entry.id);
    assert.equal(sk.ok, true);
    assert.ok(sk.entry.nextRunAt > nowMs);
    assert.match(sk.entry.history.at(-1).note, /跳過/);
    // 一次性的不能用跳過 (要問使用者補不補發)
    assert.equal(store.skipMissed(c1.entry.id).ok, false);
    // 重送結果: 系列發到一半失敗, 重送成功只改狀態, 不跳課、不多扣次數
    const c3 = store.create({
      chatId: "c1", items: { text: "第1課" },
      schedule: { mode: "repeat", repeat: { kind: "series", cycle: "daily", time: "09:00" } },
      seriesItems: [{ text: "第1課" }, { text: "第2課" }],
    });
    store.recordResult(c3.entry.id, [{ ok: true }]); // 第1課送出, 系列推進到第2課
    const afterFirst = store.list().find((e) => e.id === c3.entry.id);
    assert.equal(afterFirst.seriesIndex, 1);
    assert.equal(afterFirst.sentCount, 1);
    const rr = store.recordRetryResult(c3.entry.id, [{ ok: true }], { note: "重送完成" });
    assert.equal(rr.ok, true);
    assert.equal(rr.entry.seriesIndex, 1); // 沒有再跳一課
    assert.equal(rr.entry.sentCount, 1); // 沒有多扣一次
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("flattenItems(第三階段): 系列以「這一次的那一份」為準", () => {
  const entry = {
    items: { text: "預覽不算數" },
    schedule: { mode: "repeat", repeat: { kind: "series", cycle: "daily", time: "09:00" } },
    seriesItems: [{ text: "第1課" }, { text: "第2課", images: [{ name: "a.png", sizeBytes: 10 }] }],
    seriesIndex: 1,
  };
  const flat = flattenItems(entry);
  assert.equal(flat.length, 2);
  assert.equal(flat[0].kind, "text");
  assert.equal(flat[1].kind, "image");
});
