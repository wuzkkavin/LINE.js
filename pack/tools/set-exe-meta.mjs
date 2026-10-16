// 以 resedit (純 JS 的 PE 資源編輯器, 跨平台) 改寫 Windows exe 的圖示與版本資訊。
// 用途: 把官方 node.exe 變成 AI寶.exe 的外觀 (AI寶 icon + 含版權宣告的版本字串)。
// 注意: 改寫資源會使 node.exe 原有的 Authenticode 簽章失效; 本程式本來就不打算簽章,
// Windows 對未簽章 exe 僅在下載來源不明時跳 SmartScreen 提醒, 本機建置與內部使用不受影響。
import { readFileSync, writeFileSync } from "node:fs";
import { NtExecutable, NtExecutableResource, Data, Resource } from "resedit";

const LANG_EN_US = 1033;

// exePath: 要改寫的 exe; icoBuffer: ICO 檔內容; fileVersion: "1.6.5.0" 形式;
// strings: VersionInfo 字串表 (ProductName, FileDescription, LegalCopyright 等)。
export function applyExeMetadata(exePath, { icoBuffer, fileVersion, strings }) {
  const exe = NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  const iconFile = Data.IconFile.from(icoBuffer);
  const icons = iconFile.icons.map((item) => item.data);
  if (icons.length === 0) throw new Error("ICO 內沒有可用的圖示資料");
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, LANG_EN_US, icons);

  const existing = Resource.VersionInfo.fromEntries(res.entries);
  const vi = existing.length > 0 ? existing[0] : Resource.VersionInfo.createEmpty();
  vi.setFileVersion(fileVersion, LANG_EN_US);
  vi.setStringValues({ lang: LANG_EN_US, codepage: 1200 }, strings);
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  writeFileSync(exePath, Buffer.from(exe.generate()));
}

// 讀回 exe 的圖示組數與版本字串 (驗證用)。解析失敗時回傳 { error }。
export function readExeMetadata(exePath) {
  try {
    const exe = NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
    const res = NtExecutableResource.from(exe);
    const groups = Resource.IconGroupEntry.fromEntries(res.entries);
    const iconCount = groups.reduce((sum, g) => sum + g.icons.length, 0);
    const vis = Resource.VersionInfo.fromEntries(res.entries);
    let strings = {};
    if (vis.length > 0) {
      const langs = vis[0].getAllLanguagesForStringValues();
      if (langs.length > 0) strings = vis[0].getStringValues(langs[0]);
    }
    return { iconGroups: groups.length, iconCount, versionStrings: strings };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
