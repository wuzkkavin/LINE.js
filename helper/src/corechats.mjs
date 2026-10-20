// 透過核心的「網頁通道」讀取已登入帳號的聊天室清單, 讓使用者用選的加入白名單。
//
// 為什麼不用機器人通道 (/api/ws): 核心 hub 的 botChannels() 只回 api.chats 白名單內的聊天室
// (上游 src/ws/hub.ts), 還沒加入白名單的群組根本看不到, 無法用來「發現」新群組;
// AGENTS.md 安全規則也明定機器人連線不給 channels:refresh。
// 網頁通道的證據: 上游 src/ws/protocol.ts 有 channels 影格與 channels:refresh 請求;
// hub.ts 的 sendReady() 在頁面連線登入完成時送出完整 snapshotChannels();
// 上游自己的 CLI (src/cli.ts) 就是非瀏覽器用戶端: 先 HTTP GET / 拿 linejs_browser cookie,
// 再帶 Host/Origin/Cookie 升級 WS。本模組照同一套作法, 不修改上游任何檔案。
import { request } from "node:http";
import WebSocket from "ws";

// 只列能當機器人服務對象的聊天室種類 (個人 user 不列入白名單候選)。值是顯示排序。
const CHAT_KIND_ORDER = { group: 0, room: 1, square: 2 };

// 由機器人 API 位址 (例如 ws://127.0.0.1:3789/api/ws) 推導核心的 HTTP 來源與網頁 WS 位址。
export function coreEndpoints(lineApiUrl) {
  const u = new URL(String(lineApiUrl || "ws://127.0.0.1:3789/api/ws"));
  const authority = u.host;
  return {
    host: u.hostname,
    port: Number(u.port || 3789),
    authority,
    httpBase: `http://${authority}`,
    pageWsUrl: `ws://${authority}/ws`,
  };
}

// 拿核心發給自家頁面的瀏覽器 cookie (linejs_browser)。作法比照上游 src/cli.ts 的 fetchCookie。
export function fetchCoreCookie({ host, port, authority, timeoutMs = 5000, requestImpl = request } = {}) {
  return new Promise((resolve, reject) => {
    const fail = (e) => reject(Object.assign(new Error(String(e?.message ?? e)), { code: "CORE_UNREACHABLE" }));
    let req;
    try {
      req = requestImpl({ host, port, path: "/", method: "GET", headers: { Host: authority }, timeout: timeoutMs }, (res) => {
        res.resume();
        const cookie = res.headers["set-cookie"]?.[0]?.split(";")[0];
        if (res.statusCode === 200 && cookie) resolve(cookie);
        else fail(new Error(`核心回應 ${res.statusCode ?? "?"} 且沒有給 cookie`));
      });
    } catch (e) {
      fail(e);
      return;
    }
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", fail);
    req.end();
  });
}

// 連上核心網頁通道, 取得聊天室清單。
// 回傳判別物件 (預期內的狀態不丟例外):
//   { status: "ok", channels }        channels 是核心 Channel DTO 陣列 (refresh 後的版本優先)
//   { status: "not-logged-in" }        核心有回應, 但登入還沒完成 (idle/error/authenticating)
//   { status: "unreachable" }          連不上核心 (服務沒開、cookie 拿不到、WS 被拒)
//   { status: "timeout" }              核心有連上但等太久 (例如正在恢復登入 restoring)
export function fetchCoreChannels({
  lineApiUrl,
  timeoutMs = 12000,
  refreshWaitMs = 6000,
  settleMs = 1200,
  cookieImpl = fetchCoreCookie,
  wsImpl = null,
} = {}) {
  const ep = coreEndpoints(lineApiUrl);
  return (async () => {
    let cookie;
    try {
      cookie = await cookieImpl({ host: ep.host, port: ep.port, authority: ep.authority, timeoutMs: 5000 });
    } catch {
      return { status: "unreachable" };
    }
    return await new Promise((resolve) => {
      let done = false;
      let first = null; // 第一份 channels 快照 (登入完成時核心主動送的)
      let lastState = null;
      let stateAt = 0;
      let ws = null;
      let refreshTimer = null;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        clearInterval(tick);
        if (refreshTimer) clearTimeout(refreshTimer);
        try { ws?.close(); } catch {}
        resolve(result);
      };
      const deadline = setTimeout(() => {
        if (first) finish({ status: "ok", channels: first });
        else if (lastState && lastState !== "ready" && lastState !== "restoring") finish({ status: "not-logged-in" });
        else finish({ status: "timeout" });
      }, timeoutMs);
      // 已確定未登入的狀態 (idle/error/authenticating) 出現後, 給一小段寬限等 channels
      // (ready 的話快照會緊接著到), 寬限過了就提早定案, 不讓使用者乾等整個 timeout。
      const tick = setInterval(() => {
        if (first === null && lastState && lastState !== "ready" && lastState !== "restoring" && Date.now() - stateAt > settleMs) {
          finish({ status: "not-logged-in" });
        }
      }, 100);
      try {
        const make = wsImpl ?? ((url, opts) => new WebSocket(url, opts));
        ws = make(ep.pageWsUrl, { headers: { Host: ep.authority, Origin: `http://${ep.authority}`, Cookie: cookie } });
      } catch {
        finish({ status: "unreachable" });
        return;
      }
      ws.on("message", (data) => {
        let frame;
        try { frame = JSON.parse(data.toString()); } catch { return; }
        if (!frame || typeof frame.type !== "string") return;
        if (frame.type === "auth:state" && typeof frame.state === "string") {
          lastState = frame.state;
          stateAt = Date.now();
          return;
        }
        if (frame.type === "channels" && Array.isArray(frame.channels)) {
          if (first === null) {
            first = frame.channels;
            // 已拿到登入當下的快照; 再請核心向 LINE 重新整理一次, 拿到就用新的 (群組可能剛被邀請)。
            try { ws.send(JSON.stringify({ type: "channels:refresh" })); } catch {}
            refreshTimer = setTimeout(() => finish({ status: "ok", channels: first }), refreshWaitMs);
          } else {
            finish({ status: "ok", channels: frame.channels });
          }
          return;
        }
        if (frame.type === "error" && frame.code === "CHANNELS_FAILED") {
          if (first) finish({ status: "ok", channels: first });
          else finish({ status: "timeout" });
        }
      });
      ws.on("error", () => {
        if (first) finish({ status: "ok", channels: first });
        else finish({ status: "unreachable" });
      });
      ws.on("close", () => {
        if (first) finish({ status: "ok", channels: first });
        else if (!done) finish({ status: "unreachable" });
      });
    });
  })();
}

// 把核心 Channel DTO 陣列整理成給畫面用的清單: 只留群組/聊天室/社群、去掉個人,
// 標記是否已在白名單, 依種類與名稱排序。同 ID 重複只留第一筆。
export function shapeChatList(channels, whitelist = []) {
  const wl = new Set(whitelist ?? []);
  const seen = new Map();
  for (const c of channels ?? []) {
    if (!c || typeof c.channelId !== "string" || !(c.kind in CHAT_KIND_ORDER)) continue;
    if (seen.has(c.channelId)) continue;
    seen.set(c.channelId, {
      id: c.channelId,
      name: String(c.name ?? "").trim() || "(未命名)",
      kind: c.kind,
      memberCount: Number.isSafeInteger(c.memberCount) ? c.memberCount : null,
      whitelisted: wl.has(c.channelId),
    });
  }
  return [...seen.values()].sort((a, b) =>
    (CHAT_KIND_ORDER[a.kind] - CHAT_KIND_ORDER[b.kind]) || a.name.localeCompare(b.name, "zh-Hant"));
}
