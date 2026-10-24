// 控制台 HTTP 服務: 只綁 127.0.0.1; 提供狀態、設定 (遮罩)、測試連線、知識庫重整、Log 與診斷包。
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_DEFAULTS, SECRET_NAMES } from "./config.mjs";
import { KB_LARGE_FOLDER_FILES } from "./kb.mjs";
import { maskSecret } from "./secrets.mjs";
import { applyCoreApiConfig, detectPackaged, readCoreApiStatus, removeCoreApiChat, runCliToken } from "./linecfg.mjs";
import { syncJevCoreConfig } from "./jev.mjs";
import { fetchCoreChannels, shapeChatList } from "./corechats.mjs";
import { activityChatOptions, filterActivityEvents } from "./activityfilter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(here, "..", "web");
const FONT_PATH = join(here, "..", "assets", "fonts", "jf-openhuninn-2.1.ttf");
const ICON_PATH = join(here, "..", "assets", "ai-bao-icon.png");
const AVATAR_PATH = join(here, "..", "assets", "ai-bao-avatar.png");

// --- 最小 ZIP (stored, 無壓縮) 產生器, 供診斷包下載 ---
const CRC_TABLE = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function makeZip(files) {
  const chunks = []; const central = []; let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
  res.end(body);
}
async function readBody(req) {
  const parts = [];
  for await (const c of req) parts.push(c);
  if (!parts.length) return {};
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { return {}; }
}

export function createConsoleServer({ settings, secrets, ai, kb, kbPool, bot, logger, version = "0.1.0", lineEnv, outbox, adminEvents, materials } = {}) {
  // LINE 引導工具的環境: 資料目錄 (找核心 config.yaml)、是否打包版、Token 產生器 (測試可注入假的)
  const line = {
    dataDir: lineEnv?.dataDir ?? process.env.HELPER_DATA_DIR ?? join(here, "..", "data"),
    repoRoot: lineEnv?.repoRoot ?? join(here, "..", ".."),
    packaged: lineEnv?.packaged ?? detectPackaged(),
    generateToken: lineEnv?.generateToken ?? (() => runCliToken({})),
    fetchChats: lineEnv?.fetchChats ?? null, // 測試可注入假的; null 表示用真的核心網頁通道
  };
  // Token 換發/變更後: 用 bot.reconnect() 主動以新 Token 重連並驗證結果 (bot 內部會記成功/失敗原因,
  // 失敗會自動退避重試); 這裡回傳是否已連上, 讓 API 回應能誠實告訴使用者目前狀態, 不再靜默吞掉。
  async function reconnectBot() {
    if (!bot) return false;
    try { return await bot.reconnect(); } catch { return false; }
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/") {
        const html = readFileSync(join(WEB_DIR, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(html);
      }
      if (req.method === "GET" && path === "/assets/avatar.png") {
        if (!existsSync(AVATAR_PATH)) { res.writeHead(404); return res.end("avatar missing"); }
        const avatar = readFileSync(AVATAR_PATH);
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": avatar.length, "Cache-Control": "public, max-age=31536000, immutable" });
        return res.end(avatar);
      }
      if (req.method === "GET" && (path === "/assets/icon.png" || path === "/favicon.ico")) {
        if (!existsSync(ICON_PATH)) { res.writeHead(404); return res.end("icon missing"); }
        const icon = readFileSync(ICON_PATH);
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": icon.length, "Cache-Control": "public, max-age=31536000, immutable" });
        return res.end(icon);
      }
      if (req.method === "GET" && path === "/assets/font.ttf") {
        if (!existsSync(FONT_PATH)) { res.writeHead(404); return res.end("font missing"); }
        const font = readFileSync(FONT_PATH);
        res.writeHead(200, { "Content-Type": "font/ttf", "Content-Length": font.length, "Cache-Control": "public, max-age=31536000, immutable" });
        return res.end(font);
      }
      if (req.method === "GET" && path === "/api/status") {
        // service/capabilities 是身分標記: 原生 App 用它分辨 3790 上的是不是新版 helper,
        // 避免把還在跑的舊版 AI寶.exe (無 list-models、舊測試邏輯) 誤認成自己的服務 (2026-10-20 老吳實機踩到)。
        return json(res, 200, { service: "aibao-helper", version, capabilities: ["list-models", "line-config", "token-gen", "outbox", "admin-notify", "chat-profiles", "chatty-mode"], bot: bot ? bot.status() : null, serverTime: new Date().toISOString() });
      }
      if (req.method === "GET" && path === "/api/bot/activity") {
        // 機器人聊天情況 (第 12 項): 狀態列摘要 + 最近動態 (記憶體環形緩衝, 新到舊)。
        // 唯讀、本機限定 (整個 server 只綁 127.0.0.1, 與既有端點同一認證面)。
        // events 的 question 只是前 30 字片段且從不落盤 (見 bot.recordActivity)。
        // 群組篩選 (2026-10-23 老吳裁示): ?chat=<chatId> 只回該群的紀錄 (純顯示層,
        // 不改動紀錄本身); chats 是選單用的不重複群組清單, total 是未篩選總筆數,
        // 供畫面把「顯示筆數/全部筆數」分開標明。不帶 chat 時 events 與改版前相同。
        const all = bot ? bot.activitySnapshot() : [];
        const chat = url.searchParams.get("chat") ?? "";
        return json(res, 200, { ok: true, status: bot ? bot.status() : null, events: filterActivityEvents(all, chat), chats: activityChatOptions(all), total: all.length });
      }
      // 待發清單/發送紀錄 (發送群組訊息): 只做本機存放與規則, 實際送出由 App 殼負責 (見根目錄施工紀錄的分工定案)
      if (req.method === "GET" && path === "/api/outbox") {
        return json(res, 200, { ok: true, entries: outbox ? outbox.list() : [] });
      }
      if (req.method === "POST" && path === "/api/outbox") {
        if (!outbox) return json(res, 400, { ok: false, message: "待發清單尚未啟用" });
        const body = await readBody(req);
        const r = outbox.create(body);
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, entry: r.entry } : { ok: false, message: r.errors.join("；") });
      }
      if (req.method === "POST" && path === "/api/outbox/update") {
        if (!outbox) return json(res, 400, { ok: false, message: "待發清單尚未啟用" });
        const body = await readBody(req);
        const r = outbox.update(body?.id, body?.patch);
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, entry: r.entry } : { ok: false, message: r.errors.join("；") });
      }
      if (req.method === "POST" && path === "/api/outbox/cancel") {
        if (!outbox) return json(res, 400, { ok: false, message: "待發清單尚未啟用" });
        const body = await readBody(req);
        const r = outbox.cancel(body?.id);
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, entry: r.entry } : { ok: false, message: r.errors.join("；") });
      }
      if (req.method === "POST" && path === "/api/outbox/result") {
        if (!outbox) return json(res, 400, { ok: false, message: "待發清單尚未啟用" });
        const body = await readBody(req);
        const r = outbox.recordResult(body?.id, body?.results, { note: typeof body?.note === "string" ? body.note : "" });
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, entry: r.entry } : { ok: false, message: r.errors.join("；") });
      }
      // 排程護欄用的三個動作 (第三階段): 暫停/恢復 (鑰匙不正常)、順延 (加人交接窗口)、跳過錯過的那一次 (重複發)
      if (req.method === "POST" && path === "/api/outbox/pause") {
        if (!outbox) return json(res, 400, { ok: false, message: "待發清單尚未啟用" });
        const body = await readBody(req);
        const r = outbox.setPaused(body?.id, body?.paused !== false, typeof body?.note === "string" ? body.note : "", typeof body?.reason === "string" ? body.reason : "");
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, entry: r.entry } : { ok: false, message: r.errors.join("；") });
      }
      if (req.method === "POST" && path === "/api/outbox/defer") {
        if (!outbox) return json(res, 400, { ok: false, message: "待發清單尚未啟用" });
        const body = await readBody(req);
        const r = outbox.defer(body?.id, Number(body?.nextRunAt), typeof body?.note === "string" ? body.note : "");
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, entry: r.entry } : { ok: false, message: r.errors.join("；") });
      }
      if (req.method === "POST" && path === "/api/outbox/skip") {
        if (!outbox) return json(res, 400, { ok: false, message: "待發清單尚未啟用" });
        const body = await readBody(req);
        const r = outbox.skipMissed(body?.id, typeof body?.note === "string" ? body.note : "");
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, entry: r.entry } : { ok: false, message: r.errors.join("；") });
      }
      if (req.method === "POST" && path === "/api/outbox/retry-result") {
        if (!outbox) return json(res, 400, { ok: false, message: "待發清單尚未啟用" });
        const body = await readBody(req);
        const r = outbox.recordRetryResult(body?.id, body?.results, { note: typeof body?.note === "string" ? body.note : "" });
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, entry: r.entry } : { ok: false, message: r.errors.join("；") });
      }
      // 管理員通知: 事件紀錄查詢 + 殼端送出結果寫回 + 待送清單 (殼端輪詢領取)
      if (req.method === "GET" && path === "/api/admin-events") {
        // 領取前先結算到期的合併彙總 (節流窗已過的被合併事件補送一則彙總, 見 adminnotify)
        if (adminEvents?.collectDueSummaries) { try { adminEvents.collectDueSummaries(); } catch { /* 彙總失敗不擋查詢 */ } }
        return json(res, 200, { ok: true, events: adminEvents ? adminEvents.list() : [], pending: adminEvents ? adminEvents.pendingNotify() : [] });
      }
      if (req.method === "POST" && path === "/api/admin-events/sent") {
        if (!adminEvents) return json(res, 400, { ok: false, message: "管理員通知尚未啟用" });
        const body = await readBody(req);
        const r = adminEvents.markSent(body?.id, body?.ok === true, typeof body?.note === "string" ? body.note : "");
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, event: r.event } : { ok: false, message: r.errors.join("；") });
      }
      // 管理員候選名單 (第四階段): 該室近期發言者 + 該室 OpenChat 管理員, 供管理員勾選。
      // 必須帶 query 參數 chat (修復版6: 只回該聊天室的候選, 不得混室; 2026-10-25 老吳定案:
      // 備援聯集已廢除, 不帶 chat 不再回跨室聯集, 直接回白話錯誤)。
      // 可選 query 參數 all=1 (修復版6 擴充, 選人原則「人多的情境先行」): 預設只列近期在該室
      // 發言過的人 + 該室社群管理員; all=1 放寬為曾記錄過的本室發言者全部 + 該室社群管理員。
      // 平台事實 (已查證): 機器人 API 沒有列出群組完整成員名單的接口, all 模式涵蓋的是
      // 「曾在本室出現過的人 + 社群管理員」, 從未出現過的人列不出來, 回應不假裝是全員名單。
      if (req.method === "GET" && path === "/api/admin-candidates") {
        const chat = url.searchParams.get("chat") ?? "";
        const all = url.searchParams.get("all") === "1";
        if (!chat) return json(res, 400, { ok: false, message: "請先選一個聊天室，管理員只能從該室成員裡選。" });
        const candidates = bot ? await bot.adminCandidates(chat, { all }).catch(() => []) : [];
        return json(res, 200, { ok: true, candidates });
      }
      // 教材庫 (第三階段): 「發送群組訊息」可重複取用的圖片/檔案, 存 helper 資料目錄
      if (req.method === "GET" && path === "/api/materials") {
        return json(res, 200, { ok: true, materials: materials ? materials.list() : [] });
      }
      if (req.method === "POST" && path === "/api/materials") {
        if (!materials) return json(res, 400, { ok: false, message: "教材庫尚未啟用" });
        const body = await readBody(req);
        const buf = typeof body?.dataBase64 === "string" ? Buffer.from(body.dataBase64, "base64") : null;
        if (!buf) return json(res, 400, { ok: false, message: "檔案內容不正確" });
        const r = materials.save(body?.name, buf);
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, material: r.value } : { ok: false, message: r.errors.join("；") });
      }
      if (req.method === "GET" && path === "/api/materials/file") {
        const name = new URL(req.url, "http://127.0.0.1").searchParams.get("name") ?? "";
        const buf = materials ? materials.read(name) : null;
        if (!buf) { res.writeHead(404); return res.end("not found"); }
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": buf.length, "Cache-Control": "no-store" });
        return res.end(buf);
      }
      if (req.method === "GET" && path === "/api/settings") {
        return json(res, 200, await settings.publicView(secrets));
      }
      if (req.method === "PUT" && path === "/api/settings") {
        const body = await readBody(req);
        // 機密分流: providers.<id>.apiKey 與 scam.jev.apiKey 只進 SecretStore
        const keyUpdates = [];
        for (const pid of Object.keys(PROVIDER_DEFAULTS)) {
          const incoming = body?.ai?.providers?.[pid]?.apiKey;
          if (typeof incoming === "string" && incoming) {
            if (incoming === "__clear__") keyUpdates.push(secrets.delete(SECRET_NAMES[pid]));
            else { keyUpdates.push(secrets.set(SECRET_NAMES[pid], incoming)); logger?.addSecret(incoming); }
          }
          if (body?.ai?.providers?.[pid]) delete body.ai.providers[pid].apiKey;
        }
        if (typeof body?.scam?.jev?.apiKey === "string" && body.scam.jev.apiKey) {
          if (body.scam.jev.apiKey === "__clear__") keyUpdates.push(secrets.delete(SECRET_NAMES.jev));
          else keyUpdates.push(secrets.set(SECRET_NAMES.jev, body.scam.jev.apiKey));
          delete body.scam.jev.apiKey;
        }
        // LINE 機器人 Token 也只進 SecretStore, 不進設定 JSON; 存完讓機器人用新 Token 重連
        let lineTokenChanged = false;
        if (typeof body?.line?.apiKey === "string" && body.line.apiKey) {
          if (body.line.apiKey === "__clear__") keyUpdates.push(secrets.delete(SECRET_NAMES.lineToken));
          else { keyUpdates.push(secrets.set(SECRET_NAMES.lineToken, body.line.apiKey)); logger?.addSecret(body.line.apiKey); }
          lineTokenChanged = true;
        }
        if (body?.line) delete body.line;
        await Promise.all(keyUpdates);
        settings.update(body);
        // 分群知識庫預熱: 有專屬資料夾的群在存檔後同步建立/更新各自索引 (背景掃描)
        let chatKbNotices = [];
        if (kbPool) {
          try {
            if (typeof body?.kb?.folder === "string") kbPool.setGlobalFolder(body.kb.folder);
            const warmed = kbPool.syncFromSettings(settings.get()) ?? [];
            for (const item of warmed) {
              if (item.fileCount > KB_LARGE_FOLDER_FILES) {
                chatKbNotices.push(`提醒: 有一個群組專屬的知識庫資料夾「${item.folder}」有 ${item.fileCount} 個文件檔案, 數量非常多 — 建立索引會在背景花比較久的時間 (不影響其他功能)。建議另外建一個只放要給 AI 參考文件的專用資料夾, 會快很多。`);
              }
            }
          } catch (e) {
            logger?.warn("設定", "分群知識庫同步發生錯誤, 已略過", { error: String(e?.message ?? e) });
          }
        }
        if (lineTokenChanged) await reconnectBot().catch(() => {});
        // Jev 接通同步: 每次存檔後把核心 config.yaml 的 jev 區段與目前設定/金鑰對齊
        // (啟用且有金鑰就寫入、停用或清除金鑰就清空; 只動 jev 區段, 安全規格同白名單寫入)。
        // 同步失敗只記 log, 不擋設定存檔本身 (syncJevCoreConfig 內部已保證不寫壞檔案)。
        await syncJevCoreConfig({ dataDir: line.dataDir, repoRoot: line.repoRoot, settings, secrets, logger })
          .catch((e) => logger?.warn("防詐騙", "Jev 核心設定同步發生錯誤, 已保留原設定", { error: String(e?.message ?? e) }));
        if (bot?.refreshJevState) await bot.refreshJevState().catch(() => {});
        // 知識庫掃描改在背景跑: 大資料夾掃描要很久, 設定回應不能等它 (舊版同步掃描把這支 API
        // 卡住 100+ 秒, App 端直接逾時跳 Network Error — 2026-10-20 實機定案之二)。
        let kbNotice = chatKbNotices.join(" ");
        if (kbPool && typeof body?.kb?.folder === "string") kbPool.setGlobalFolder(body.kb.folder);
        if (kb && typeof body?.kb?.folder === "string") {
          kb.setFolder(body.kb.folder);
          void kb.scan();
          if (body.kb.folder) {
            const n = kb.countSupportedFiles();
            if (n > KB_LARGE_FOLDER_FILES) {
              const globalNotice = `提醒: 這個知識庫資料夾有 ${n} 個文件檔案, 數量非常多 — 建立索引會在背景花比較久的時間 (不影響其他功能), 之後每次重整也會久。建議另外建一個只放要給 AI 參考文件的專用資料夾, 會快很多。`;
              kbNotice = kbNotice ? `${kbNotice} ${globalNotice}` : globalNotice;
            }
          }
        }
        const s = settings.get();
        logger?.info("設定", "設定已更新", { botName: s.botName, aiActive: s.ai.active, triggerMode: s.triggerMode });
        return json(res, 200, { ok: true, settings: await settings.publicView(secrets), kbNotice, message: "已儲存, 馬上生效 (不用重開程式)" + (kbNotice ? ` ${kbNotice}` : "") });
      }
      if (req.method === "POST" && path === "/api/test-ai") {
        const body = await readBody(req);
        const pid = body.provider;
        if (!PROVIDER_DEFAULTS[pid]) return json(res, 400, { ok: false, message: "不知道這家 AI 供應商, 請重新整理頁面再試一次" });
        const cfg = settings.get().ai.providers[pid];
        // 測試時可用尚未儲存的 Key/欄位 (從表單帶來)
        const key = body.apiKey || (secrets ? await secrets.get(SECRET_NAMES[pid]) : null);
        const result = await ai.testConnection({ baseUrl: body.baseUrl || cfg.baseUrl, model: body.model || cfg.model }, key);
        logger?.info("設定", "AI 測試連線", { provider: pid, ok: result.ok, ms: result.latencyMs });
        return json(res, 200, result);
      }
      if (req.method === "POST" && path === "/api/list-models") {
        const body = await readBody(req);
        const pid = body.provider;
        if (!PROVIDER_DEFAULTS[pid]) return json(res, 400, { ok: false, message: "不知道這家 AI 供應商, 請重新整理頁面再試一次" });
        const cfg = settings.get().ai.providers[pid];
        // 抓清單時可用尚未儲存的 Key/欄位 (從表單帶來), 沒帶就用已儲存的 Key
        const key = body.apiKey || (secrets ? await secrets.get(SECRET_NAMES[pid]) : null);
        const result = await ai.listModels({ baseUrl: body.baseUrl || cfg.baseUrl }, key);
        logger?.info("設定", "AI 模型清單抓取", { provider: pid, ok: result.ok, count: result.models?.length ?? 0 });
        return json(res, 200, result);
      }
      if (req.method === "GET" && path === "/api/line/config-status") {
        return json(res, 200, { ok: true, ...readCoreApiStatus(line) });
      }
      if (req.method === "GET" && path === "/api/line/chats") {
        // 用選的加入白名單: 透過核心網頁通道讀已登入帳號的聊天室清單 (corechats.mjs), 合併白名單狀態。
        const status = readCoreApiStatus(line);
        const r = line.fetchChats
          ? await line.fetchChats()
          : await fetchCoreChannels({ lineApiUrl: settings.get().lineApiUrl });
        // 每種結果都入 log (第 5 項觀測性修復): 舊版只有成功才記, 失敗時 log 全無痕跡,
        // 實機出問題時無法分辨「請求沒到 helper」還是「helper 處理失敗」。
        logger?.info("設定", "LINE 群組清單讀取結果", { status: r.status });
        if (r.status === "not-logged-in") {
          return json(res, 200, { ok: false, code: "NOT_LOGGED_IN", message: "LINE 還沒有登入完成。請先完成 LINE 登入 (用次要帳號掃 QR), 再回來讀取群組清單。" });
        }
        if (r.status === "unreachable") {
          return json(res, 200, { ok: false, code: "CORE_UNREACHABLE", message: "連不上 LINE 核心服務。請確認 AI寶 引擎正在執行, 等幾秒再試一次。" });
        }
        if (r.status !== "ok") {
          return json(res, 200, { ok: false, code: "CORE_TIMEOUT", message: "等核心回應等太久了。請稍等幾秒, 再按一次「讀取我的群組清單」。" });
        }
        const chats = shapeChatList(r.channels, status.chats);
        logger?.info("設定", "LINE 群組清單讀取", { count: chats.length });
        return json(res, 200, {
          ok: true,
          apiEnabled: status.apiEnabled,
          chats,
          message: chats.length
            ? `讀到了 ${chats.length} 個群組/聊天室, 點你要用的那個按「加入白名單」。`
            : "這個帳號目前還沒有加入任何群組。請先用手機 LINE 把這個次要帳號邀請進你要用的群組, 再回來按一次「讀取我的群組清單」。",
        });
      }
      if (req.method === "GET" && path === "/api/line/whitelist") {
        // 已儲存白名單逐筆列出 (修復項 8): 只給計數看不到內容、不能管理; 名稱用核心快照對照解析,
        // 核心讀不到時退回只給 ID 並標記 nameResolved=false, 清單本身永遠要列得出來。
        const status = readCoreApiStatus(line);
        // 名稱連同類型/人數一起解析 (2026-10-21 版面整理): 資料本來就在同一份核心快照裡,
        // 舊版只留名稱、把 kind/memberCount 丟掉, 介面只能顯示 ID 補位; 現在三欄一起帶,
        // 純呈現擴充, 白名單的讀寫路徑與行為不變。
        let infoById = new Map();
        let coreAvailable = false;
        try {
          const r = line.fetchChats
            ? await line.fetchChats()
            : await fetchCoreChannels({ lineApiUrl: settings.get().lineApiUrl });
          if (r.status === "ok") {
            coreAvailable = true;
            for (const c of shapeChatList(r.channels, [])) infoById.set(c.id, c);
          }
        } catch { /* 核心不可用: 名稱留空, 清單照樣回 */ }
        const chats = (status.chats ?? []).map((id) => {
          const info = infoById.get(id);
          return {
            id,
            name: info?.name ?? null,
            nameResolved: !!info,
            kind: info?.kind ?? null,
            memberCount: info?.memberCount ?? null,
          };
        });
        return json(res, 200, { ok: true, apiEnabled: status.apiEnabled, coreAvailable, chats });
      }
      if (req.method === "POST" && path === "/api/line/config-apply") {
        const body = await readBody(req);
        try {
          const r = applyCoreApiConfig({ dataDir: line.dataDir, repoRoot: line.repoRoot, chatId: String(body.chatId ?? "") });
          logger?.info("設定", "LINE 白名單已更新", { path: r.path, chats: r.chats.length });
          return json(res, 200, { ok: true, ...r, message: "已啟用機器人 API, 並把這個群組加入白名單。請把 AI寶 完全關閉再重新開啟, 才會生效; 重開後再回來做步驟三產生 Token。" });
        } catch (e) {
          return json(res, 200, { ok: false, message: String(e?.message ?? e) });
        }
      }
      if (req.method === "POST" && path === "/api/line/config-remove") {
        const body = await readBody(req);
        try {
          const r = removeCoreApiChat({ dataDir: line.dataDir, repoRoot: line.repoRoot, chatId: String(body.chatId ?? "") });
          logger?.info("設定", "LINE 白名單已移除", { path: r.path, chats: r.chats.length });
          return json(res, 200, { ok: true, ...r, message: "已把這個群組移出白名單。請把 AI寶 完全關閉再重新開啟, 才會生效。" });
        } catch (e) {
          return json(res, 200, { ok: false, message: String(e?.message ?? e) });
        }
      }
      if (req.method === "POST" && path === "/api/line/generate-token") {
        if (!line.packaged) {
          return json(res, 200, { ok: false, devMode: true, message: "目前是開發模式, 自動產生 Token 只在打包版 (AI寶.exe / aibao) 提供。開發模式請在核心目錄執行: npm run cli -- token --yes, 再把產生的 Token 貼到上方欄位按儲存。" });
        }
        try {
          const token = await line.generateToken();
          await secrets.set(SECRET_NAMES.lineToken, token);
          logger?.addSecret(token);
          // 核心在換發 Token 的當下就會踢掉機器人連線; 必須主動以新 Token 重連並驗證有沒有連上,
          // 結果直接寫進回應訊息, 連不上就明說會自動重試 (2026-10-20 實機: 沒重連成功也沒人知道)。
          const reconnected = await reconnectBot();
          const masked = maskSecret(token);
          logger?.info("設定", "LINE Token 已自動產生並儲存", { last4: masked.last4, botReconnected: reconnected });
          return json(res, 200, {
            ok: true, ...masked, botConnected: reconnected,
            message: reconnected
              ? "已產生新 Token 並自動儲存好了 (舊 Token 已失效), 機器人已用新 Token 重新連線完成。"
              : "已產生新 Token 並自動儲存好了 (舊 Token 已失效), 但機器人暫時連不上核心, 系統會自動重試連線。請看總覽的「機器人連線」狀態; 若一直顯示未連線, 請重新啟動 AI寶。",
          });
        } catch (e) {
          logger?.warn("設定", "LINE Token 自動產生失敗", { error: String(e?.message ?? e) });
          return json(res, 200, { ok: false, message: String(e?.message ?? e) });
        }
      }
      if (req.method === "POST" && path === "/api/kb/reindex") {
        if (!kb) return json(res, 400, { ok: false, message: "知識庫尚未啟用" });
        // 任何狀態都要在短時間內回 JSON (修復批次一, 第 4 項): 舊版在掃描進行中再打這支 API,
        // 會跟著等進行中的掃描 (最長等到 15 秒逾時才回), UI 看起來像當掉、App 端直接逾時。
        // 現在: 已在掃描中就立刻回 already-scanning (這次要求會由 kb.scan 的排隊機制在該輪後補做);
        // 沒在掃描才啟動新掃描, 而且只短等 1 秒 — 小資料夾直接回完成結果, 大資料夾回背景整理中,
        // 進度看 /api/status 的 scanning 欄位, 不把這支 API 掛住。
        if (kb.status().scanning) {
          void kb.scan({ force: true }); // 排隊補做一次 (kb.scan 進行中呼叫只登記需求, 不重複跑)
          const st = kb.status();
          return json(res, 200, { ok: true, scanState: "already-scanning", queued: true, status: st, scanning: true, message: "知識庫正在整理中, 這次重新整理的要求已經排入, 會接著處理; 你可以先做別的事, 狀態會自動更新。" });
        }
        const scanP = kb.scan({ force: true });
        const finished = await Promise.race([scanP.then(() => true), new Promise((r) => setTimeout(() => r(false), 1000))]);
        const st = kb.status();
        if (!finished) {
          return json(res, 200, { ok: true, scanState: "scanning", status: st, scanning: true, message: "檔案很多, 正在背景整理索引 (不會卡住其他功能); 整理完成後, 知識庫狀態會自動更新。" });
        }
        return json(res, 200, { ok: true, scanState: "completed", status: st, message: st.ready ? `整理完成: ${st.files} 個檔案、${st.chunks} 段` : "資料夾裡沒有可讀的 .txt/.md/.csv 檔案, 請確認資料夾路徑與檔案格式" });
      }
      if (req.method === "GET" && path === "/api/logs") {
        const tail = (logger?.readToday() ?? "").split("\n").slice(-200).join("\n");
        return json(res, 200, { files: logger?.listFiles() ?? [], tail });
      }
      if (req.method === "GET" && path === "/api/diagnostic") {
        const view = await settings.publicView(secrets);
        const summary = { version, exportedAt: new Date().toISOString(), platform: process.platform, botStatus: bot ? bot.status() : null, settingsMasked: view, secretStoreKind: secrets?.kind ?? "none" };
        const files = [{ name: "summary.json", data: Buffer.from(JSON.stringify(summary, null, 2), "utf8") }];
        // 保留期內的 log 全部打包 (Logger 保留天數預設 14 天); 舊版只包最近 3 檔, 跨日問題常查不到
        for (const name of logger?.listFiles() ?? []) {
          try { files.push({ name: `logs/${name}`, data: readFileSync(join(logger.dir, name)) }); } catch {}
        }
        // 核心最近輸出尾段 (2026-10-21 第二段): 啟動器把核心的 stdout/stderr 導到同一個 logs
        // 目錄的 launcher-core.log; 以前診斷包沒包它, 核心側事故 (例如訊息解密失敗) 完全沒證據。
        // 檔案會一直長大, 只節錄最後 256KB 並在檔頭註明; 找不到檔案時在 summary.coreLog
        // 誠實記錄原因 (開發模式或引擎尚未啟動), 不硬湊。
        const CORE_LOG_TAIL = 256 * 1024;
        try {
          const coreLogPath = join(logger.dir, "launcher-core.log");
          if (existsSync(coreLogPath)) {
            const raw = readFileSync(coreLogPath);
            const data = raw.length > CORE_LOG_TAIL
              ? Buffer.concat([Buffer.from("（診斷包只節錄最後 256KB, 完整檔案在本機 logs/launcher-core.log）\n", "utf8"), raw.subarray(raw.length - CORE_LOG_TAIL)])
              : raw;
            files.push({ name: "logs/launcher-core.log", data });
            summary.coreLog = { included: true, bytes: raw.length, tailed: raw.length > CORE_LOG_TAIL };
          } else {
            summary.coreLog = { included: false, reason: "找不到 launcher-core.log (引擎尚未啟動, 或目前是開發模式)" };
          }
        } catch (e) {
          summary.coreLog = { included: false, reason: `讀取核心 log 失敗: ${String(e?.message ?? e)}` };
        }
        files[0] = { name: "summary.json", data: Buffer.from(JSON.stringify(summary, null, 2), "utf8") };
        const zip = makeZip(files);
        res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": "attachment; filename=helper-diagnostic.zip", "Content-Length": zip.length });
        return res.end(zip);
      }
      if (req.method === "GET" && path === "/api/log-dir") {
        return json(res, 200, { dir: logger?.dir ?? "", message: "Log 資料夾位置如上; 在 Windows 上可用檔案總管貼上這個路徑開啟" });
      }
      // 未知路徑回 JSON (帶白話 message): 舊版回 text/plain 無訊息, App 端只能顯示
      // 「回應狀態異常」且 log 查不到狀態碼以外的線索 (2026-10-20 群組清單事故的觀測性缺口)。
      logger?.warn("控制台", "未知路徑", { method: req.method, path });
      return json(res, 404, { ok: false, code: "NOT_FOUND", message: "找不到這個路徑" });
    } catch (e) {
      // 原始錯誤只進 log; 回給畫面的只有白話說明與下一步, 不外露例外字串或狀態碼 (修復批次一, 第 7 項)
      logger?.error("控制台", "API 處理失敗", { path, error: String(e?.message ?? e) });
      return json(res, 500, { ok: false, message: "發生錯誤, 這次沒有完成。下一步: 重新整理頁面再試一次; 若一直失敗, 請到下方下載診斷包給維護人員。" });
    }
  });
  return server;
}

export function listenConsole(server, port = 3790) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}
