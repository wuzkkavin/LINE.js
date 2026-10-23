// 機器人聊天情況的群組篩選 (2026-10-23 老吳裁示: 活動清單要能依群組篩選)。
// 純顯示層邏輯: 活動紀錄本身仍是全域混排存放在 bot.activity (環形緩衝),
// 這裡只決定「畫面顯示哪幾筆」與「下拉選單列哪些群組」, 不改動紀錄本身、
// 不影響任何群內行為。篩選一律以 chatId 為準 (群名會變、編號不會);
// 顯示名稱取該群最近一筆紀錄的 chatName, 最近一筆沒名稱時往較舊的同群紀錄補。

// 由新到舊的活動清單萃取不重複的聊天室清單 (依最近活動排序, 新的在前)。
// 沒有 chatId 的紀錄不屬於任何聊天室, 不列入選單 (只在「全部群組」時顯示)。
export function activityChatOptions(events) {
  const list = Array.isArray(events) ? events : [];
  const seen = new Map();
  for (const ev of list) {
    const chatId = typeof ev?.chatId === "string" ? ev.chatId : "";
    if (!chatId || seen.has(chatId)) continue;
    seen.set(chatId, { chatId, chatName: typeof ev.chatName === "string" ? ev.chatName : "" });
  }
  // 名稱為空時往較舊的同群紀錄補 (最近一筆可能剛好沒帶到名稱)
  for (const ev of list) {
    const opt = seen.get(typeof ev?.chatId === "string" ? ev.chatId : "");
    if (opt && !opt.chatName && typeof ev.chatName === "string" && ev.chatName) opt.chatName = ev.chatName;
  }
  return [...seen.values()];
}

// chatId 空/未給 = 全部 (回複本, 不動原陣列); 給了就只回該聊天室的紀錄
// (順序不變), 查無此群回空陣列。
export function filterActivityEvents(events, chatId) {
  const list = Array.isArray(events) ? events : [];
  if (!chatId) return [...list];
  return list.filter((ev) => ev?.chatId === chatId);
}
