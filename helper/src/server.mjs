// 控制台 HTTP 服務: 只綁 127.0.0.1; 提供狀態、設定 (遮罩)、測試連線、知識庫重整、Log 與診斷包。
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_DEFAULTS, SECRET_NAMES } from "./config.mjs";
import { maskSecret } from "./secrets.mjs";
import { applyCoreApiConfig, detectPackaged, readCoreApiStatus, runCliToken } from "./linecfg.mjs";

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

export function createConsoleServer({ settings, secrets, ai, kb, bot, logger, version = "0.1.0", lineEnv } = {}) {
  // LINE 引導工具的環境: 資料目錄 (找核心 config.yaml)、是否打包版、Token 產生器 (測試可注入假的)
  const line = {
    dataDir: lineEnv?.dataDir ?? process.env.HELPER_DATA_DIR ?? join(here, "..", "data"),
    repoRoot: lineEnv?.repoRoot ?? join(here, "..", ".."),
    packaged: lineEnv?.packaged ?? detectPackaged(),
    generateToken: lineEnv?.generateToken ?? (() => runCliToken({})),
  };
  async function reconnectBot() {
    if (!bot) return;
    try { bot.disconnect(); await bot.connect().catch(() => {}); } catch {}
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
        return json(res, 200, { service: "aibao-helper", version, capabilities: ["list-models", "line-config", "token-gen"], bot: bot ? bot.status() : null, serverTime: new Date().toISOString() });
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
        if (lineTokenChanged) await reconnectBot();
        if (kb && typeof body?.kb?.folder === "string") { kb.setFolder(body.kb.folder); kb.scan(); }
        const s = settings.get();
        logger?.info("設定", "設定已更新", { botName: s.botName, aiActive: s.ai.active, triggerMode: s.triggerMode });
        return json(res, 200, { ok: true, settings: await settings.publicView(secrets), message: "已儲存, 馬上生效 (不用重開程式)" });
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
      if (req.method === "POST" && path === "/api/line/generate-token") {
        if (!line.packaged) {
          return json(res, 200, { ok: false, devMode: true, message: "目前是開發模式, 自動產生 Token 只在打包版 (AI寶.exe / aibao) 提供。開發模式請在核心目錄執行: npm run cli -- token --yes, 再把產生的 Token 貼到上方欄位按儲存。" });
        }
        try {
          const token = await line.generateToken();
          await secrets.set(SECRET_NAMES.lineToken, token);
          logger?.addSecret(token);
          await reconnectBot();
          const masked = maskSecret(token);
          logger?.info("設定", "LINE Token 已自動產生並儲存", { last4: masked.last4 });
          return json(res, 200, { ok: true, ...masked, message: "已產生新 Token 並自動儲存好了 (舊 Token 已失效)。機器人正在用新 Token 重新連線, 請看本頁最上方的 LINE 連線狀態。" });
        } catch (e) {
          logger?.warn("設定", "LINE Token 自動產生失敗", { error: String(e?.message ?? e) });
          return json(res, 200, { ok: false, message: String(e?.message ?? e) });
        }
      }
      if (req.method === "POST" && path === "/api/kb/reindex") {
        if (!kb) return json(res, 400, { ok: false, message: "知識庫尚未啟用" });
        const st = kb.scan({ force: true });
        return json(res, 200, { ok: true, status: st, message: st.ready ? `整理完成: ${st.files} 個檔案、${st.chunks} 段` : "資料夾裡沒有可讀的 .txt/.md/.csv 檔案, 請確認資料夾路徑與檔案格式" });
      }
      if (req.method === "GET" && path === "/api/logs") {
        const tail = (logger?.readToday() ?? "").split("\n").slice(-200).join("\n");
        return json(res, 200, { files: logger?.listFiles() ?? [], tail });
      }
      if (req.method === "GET" && path === "/api/diagnostic") {
        const view = await settings.publicView(secrets);
        const summary = { version, exportedAt: new Date().toISOString(), platform: process.platform, botStatus: bot ? bot.status() : null, settingsMasked: view, secretStoreKind: secrets?.kind ?? "none" };
        const files = [{ name: "summary.json", data: Buffer.from(JSON.stringify(summary, null, 2), "utf8") }];
        for (const name of (logger?.listFiles() ?? []).slice(-3)) {
          try { files.push({ name: `logs/${name}`, data: readFileSync(join(logger.dir, name)) }); } catch {}
        }
        const zip = makeZip(files);
        res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": "attachment; filename=helper-diagnostic.zip", "Content-Length": zip.length });
        return res.end(zip);
      }
      if (req.method === "GET" && path === "/api/log-dir") {
        return json(res, 200, { dir: logger?.dir ?? "", message: "Log 資料夾位置如上; 在 Windows 上可用檔案總管貼上這個路徑開啟" });
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("找不到這個路徑");
    } catch (e) {
      logger?.error("控制台", "API 處理失敗", { path, error: String(e?.message ?? e) });
      return json(res, 500, { ok: false, message: `發生錯誤: ${String(e?.message ?? e)}。下一步: 重新整理頁面再試; 若一直失敗, 請匯出診斷包給維護人員。` });
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
