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
  return p;
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
