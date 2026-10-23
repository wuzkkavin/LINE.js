// 分群角色定位與回答範圍: 解析每個聊天室生效的角色/範圍/知識庫設定。
// 契約: settings.ai.chatProfiles = { [chatId]: { rolePrompt, scopePrompt, kbEnabled, kbFolder, suspended } }
// 沒有條目 = 用全域預設; 有條目且 suspended=false = 本群自訂 (取代全域, 不是疊加); suspended=true = 停用 (視同用預設)。
import { DEFAULT_ROLE_PROMPT } from "./config.mjs";

export function getChatProfile(settings, chatId) {
  if (!settings || !chatId) return null;
  const profiles = settings.ai?.chatProfiles;
  if (!profiles || typeof profiles !== "object") return null;
  const p = profiles[chatId];
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (p.suspended) return null;
  // personaCustom=false: 這個條目只為了開聒噪而存在, 人設視同沒有自訂 (跟全域走)。
  // 舊存檔沒有此欄位 = undefined, 不等於 false, 行為與修復版4 相同 (有條目即自訂)。
  if (p.personaCustom === false) return null;
  return p;
}

/**
 * 這個群的聒噪模式有沒有打開 (修復版5): 條目存在、未停用、chatty 為 true 才算開。
 * 與人設是否自訂互相獨立 — 只開聒噪的群靠 personaCustom=false 也能存條目。
 */
export function isChattyEnabled(settings, chatId) {
  if (!settings || !chatId) return false;
  const profiles = settings.ai?.chatProfiles;
  if (!profiles || typeof profiles !== "object") return false;
  const p = profiles[chatId];
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  if (p.suspended) return false;
  return p.chatty === true;
}

export function resolveChatSettings(settings, chatId) {
  const ai = settings?.ai ?? {};
  const globalRoleRaw = typeof ai.rolePrompt === "string" ? ai.rolePrompt : "";
  const globalRole = globalRoleRaw.trim() ? globalRoleRaw : DEFAULT_ROLE_PROMPT;
  const globalScope = typeof ai.scopePrompt === "string" ? ai.scopePrompt : (ai.scopePrompt ?? "");
  const globalKbFolder = typeof settings?.kb?.folder === "string" ? settings.kb.folder : (settings?.kb?.folder ?? "");
  const profile = getChatProfile(settings, chatId);
  if (!profile) {
    return {
      source: "global",
      rolePrompt: globalRole,
      scopePrompt: typeof globalScope === "string" ? globalScope : "",
      kbEnabled: true,
      kbFolder: typeof globalKbFolder === "string" ? globalKbFolder : "",
    };
  }
  const roleRaw = typeof profile.rolePrompt === "string" ? profile.rolePrompt : "";
  const rolePrompt = roleRaw.trim() ? roleRaw : DEFAULT_ROLE_PROMPT;
  const scopePrompt = typeof profile.scopePrompt === "string" ? profile.scopePrompt : "";
  const kbEnabled = profile.kbEnabled !== false;
  const kbFolderRaw = typeof profile.kbFolder === "string" ? profile.kbFolder : "";
  const kbFolder = kbFolderRaw.trim() ? kbFolderRaw : (typeof globalKbFolder === "string" ? globalKbFolder : "");
  return { source: "chat", rolePrompt, scopePrompt, kbEnabled, kbFolder };
}

// 把關規則 (程式固定附加, 不是使用者欄位): 範圍外婉拒、知識庫不得繞過範圍、模糊先反問一個關鍵問題。
export const SCOPE_GUARD_RULE = [
  "把關規則 (務必遵守):",
  "1. 範圍外問題要自然親切地婉拒: 先簡短回應對方的問題, 說明你在這個群負責的範圍, 再把話題帶回範圍內可以幫忙的事情; 不要編造範圍外的答案, 也不要硬湊內容回答範圍外的問題。",
  "2. 就算知識庫片段裡有相關內容, 也不准拿來回答範圍外的問題; 知識庫片段只能用來回答範圍內的問題, 不能用知識庫繞過回答範圍。",
  "3. 問題太模糊時先親切反問: 只反問一個最關鍵的問題來確認意思 (可以給一個例子讓對方比較好回答), 不要亂猜; 對方補充說明後就正常回答, 不要連續反問。",
].join("\n");

/**
 * 保密規則 (老吳 2026-10-23 17:39 追加定案): 程式固定附加、不是使用者欄位,
 * 正式回答與聒噪接話兩條路徑的提示詞都必附 (不依賴回答範圍欄位有沒有填)。
 * AI寶 可以天南地北聊天, 但隱密機敏的事一律不能說出去: 別群的事、個人資料
 * 與帳號識別、程式設定與憑證、不是這個群能讀的知識庫內容與公司機敏事項。
 * 被套話時不證實也不否認具體內容存不存在, 自然帶開話題, 不編假話搪塞。
 */
export const CONFIDENTIALITY_RULE = [
  "保密規則 (務必遵守):",
  "1. 其他群組的事一律不透露: 別的群組聊過什麼、該群的角色或範圍設定、成員有誰, 在這個群都不可以講, 也不可以拿別的群的內容來回答這個群的問題。",
  "2. 任何人的個人資料與帳號識別資訊一律不透露: 包括使用者的 mid、誰在哪個群組、管理員名單的細節。",
  "3. 程式與憑證一律不透露: API Key、Token、程式的設定值、內部檔案路徑與運作細節都不可以講。",
  "4. 知識庫只能用這個群可以讀的範圍: 不屬於這個群可讀範圍的知識庫內容, 不可以引用、摘要或暗示; 公司機敏事項同樣不可以講。",
  "5. 有人套問上面這些資訊時, 自然親切地把話題帶開就好: 不證實也不否認具體內容存不存在, 也不要編造假資訊來搪塞。",
].join("\n");

export function buildScopeGuardSection(scopePrompt) {
  const v = typeof scopePrompt === "string" ? scopePrompt.trim() : "";
  if (!v) return "";
  return `回答範圍 (務必遵守):\n${v}\n${SCOPE_GUARD_RULE}`;
}

const DECLINED_PATTERNS = [
  /不在行/,
  /超出[^。\n]{0,30}範圍/,
  /負責的範圍/,
  /幫不上忙/,
  /不在[^。\n]{0,20}範圍/,
  /不是我[^。\n]{0,10}負責/,
  /沒辦法回答[^。\n]{0,20}範圍/,
  /不在我的範圍/,
  /超出我的[^。\n]{0,10}範圍/,
  /我負責的範圍/,
  /只能回答[^。\n]{0,20}範圍/,
  /無法幫你[^。\n]{0,10}這/,
];

const CLARIFY_PATTERNS = [
  /你說的是/,
  /你指的是/,
  /指的是/,
  /是哪一/,
  /哪一個/,
  /哪一種/,
  /是指[^？?。\n]{0,30}嗎/,
  /是[^？?。\n]{0,20}還是/,
];

export function classifyAnswerKind(answerText) {
  if (typeof answerText !== "string" || !answerText.trim()) return null;
  const text = answerText;
  for (const re of DECLINED_PATTERNS) {
    if (re.test(text)) return "declined";
  }
  // 也涵蓋較鬆的婉拒: 同時含「範圍」與「不好意思/抱歉/婉拒」語氣
  if (/範圍/.test(text) && /(不好意思|抱歉|婉拒|幫不上|不在行)/.test(text)) return "declined";
  if (/[?？]/.test(text)) {
    for (const re of CLARIFY_PATTERNS) {
      if (re.test(text)) return "clarify";
    }
  }
  return null;
}

export function guidanceForChat(botName, resolved) {
  const name = botName || "我";
  if (!resolved || resolved.source !== "chat") {
    return `我在，我是${name}。你要問什麼？可以直接打字問我，例如：${name}，Excel 怎麼凍結窗格？或是：${name}，公司彩色列印在哪裡？`;
  }
  let role = typeof resolved.rolePrompt === "string" ? resolved.rolePrompt.trim() : "";
  if (role.length > 120) role = role.slice(0, 120) + "…";
  if (role && !/[。！？.!?…]$/.test(role)) role += "。";
  return `我在，我是${name}。${role}你要問什麼？可以直接打字問我。`;
}
