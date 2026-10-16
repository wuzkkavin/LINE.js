// SecretStore: 機密存放介面與後端。
// - MemorySecretStore: 測試用, 不落盤。
// - FileSecretStore: AES-256-GCM 加密檔案 (開發用, 檔頭明示 dev; 正式 Windows 版請用認證管理員/DPAPI)。
// - WindowsSecretStore: 以 PowerShell 呼叫認證管理員 (wincred) 與 DPAPI; 非 Windows 優雅停用。
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function maskSecret(value) {
  if (!value) return { set: false, last4: "" };
  return { set: true, last4: String(value).slice(-4) };
}

export class MemorySecretStore {
  constructor() { this.map = new Map(); this.kind = "memory"; }
  async get(name) { return this.map.get(name) ?? null; }
  async set(name, value) { this.map.set(name, String(value)); }
  async delete(name) { this.map.delete(name); }
  async has(name) { return this.map.has(name); }
}

export class FileSecretStore {
  // dev 專用: 金鑰由 passphrase 以 scrypt 衍生; 預設 passphrase 僅供本機開發, 不是資安保證。
  constructor({ path, passphrase = "linejs-helper-dev-only" } = {}) {
    if (!path) throw new Error("FileSecretStore 需要 path");
    this.path = path;
    this.kind = "file-aes-dev";
    this.key = scryptSync(passphrase, "linejs-helper-dev-salt", 32);
  }
  load() {
    if (!existsSync(this.path)) return {};
    try { return JSON.parse(readFileSync(this.path, "utf8")).secrets ?? {}; } catch { return {}; }
  }
  save(all) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ format: "aes-256-gcm", dev: true, secrets: all }, null, 2), { mode: 0o600 });
  }
  async get(name) {
    const rec = this.load()[name];
    if (!rec) return null;
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(rec.iv, "base64"));
    decipher.setAuthTag(Buffer.from(rec.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(rec.data, "base64")), decipher.final()]).toString("utf8");
  }
  async set(name, value) {
    const all = this.load();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    all[name] = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    this.save(all);
  }
  async delete(name) { const all = this.load(); delete all[name]; this.save(all); }
  async has(name) { return !!this.load()[name]; }
}

function runPowerShell(script, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: timeoutMs, windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(String(stdout).trim()));
  });
}

// Windows 後端: API Key 等小機密存認證管理員 (泛型認證, 上限 2560 bytes);
// LINE session 等較大機密以 DPAPI (CurrentUser) 加密後交由呼叫端存檔, 本類別提供 protect/unprotect。
export class WindowsSecretStore {
  constructor({ logger, targetPrefix = "HwLineHelper" } = {}) {
    this.kind = "windows-credman";
    this.logger = logger;
    this.targetPrefix = targetPrefix;
    if (process.platform !== "win32") throw new Error("WindowsSecretStore 只能在 Windows 使用");
  }
  psCredScript(action, target, valueB64) {
    // 以 Add-Type 呼叫 wincred.dll 的 CredWrite/CredRead/CredDelete; 值以 Base64 傳遞避免引號問題。
    return `
$sig = @'
using System; using System.Runtime.InteropServices;
public static class CredMan {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL c, uint flags);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
}
'@
Add-Type -TypeDefinition $sig
$target = '${target}'
${action === "set" ? `
$bytes = [Convert]::FromBase64String('${valueB64}')
$blob = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
$cred = New-Object CredMan+CREDENTIAL
$cred.Type = 1; $cred.TargetName = $target; $cred.CredentialBlobSize = $bytes.Length; $cred.CredentialBlob = $blob; $cred.Persist = 2; $cred.UserName = 'helper'
if (-not [CredMan]::CredWrite([ref]$cred, 0)) { throw "CredWrite failed" }
'OK'` : action === "get" ? `
$p = [IntPtr]::Zero
if (-not [CredMan]::CredRead($target, 1, 0, [ref]$p)) { 'NOTFOUND'; exit 0 }
try { $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [Type]([CredMan+CREDENTIAL])); $b = New-Object byte[] $c.CredentialBlobSize; [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $b, 0, $c.CredentialBlobSize); [Convert]::ToBase64String($b) } finally { [CredMan]::CredFree($p) }
` : `
[CredMan]::CredDelete($target, 1, 0) | Out-Null; 'OK'
`}`;
  }
  async get(name) {
    const target = `${this.targetPrefix}/${name}`;
    const out = await runPowerShell(this.psCredScript("get", target));
    if (!out || out === "NOTFOUND") return null;
    return Buffer.from(out, "base64").toString("utf8");
  }
  async set(name, value) {
    if (Buffer.byteLength(String(value), "utf8") > 2560) throw new Error("超過認證管理員單筆上限 2560 bytes, 較大機密請改用 DPAPI");
    const target = `${this.targetPrefix}/${name}`;
    await runPowerShell(this.psCredScript("set", target, Buffer.from(String(value), "utf8").toString("base64")));
  }
  async delete(name) {
    const target = `${this.targetPrefix}/${name}`;
    await runPowerShell(this.psCredScript("delete", target));
  }
  async has(name) { return (await this.get(name)) !== null; }
  // DPAPI: 大型機密 (如 LINE session) 加密/解密; 回傳 Base64 密文, 由呼叫端放 AppData。
  async dpapiProtect(plainText) {
    const b64 = Buffer.from(String(plainText), "utf8").toString("base64");
    const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${b64}'); $e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); [Convert]::ToBase64String($e)`;
    return runPowerShell(script);
  }
  async dpapiUnprotect(cipherB64) {
    const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${cipherB64}'); $d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); [Convert]::ToBase64String($d)`;
    const out = await runPowerShell(script);
    return Buffer.from(out, "base64").toString("utf8");
  }
}

// 工廠: Windows 用認證管理員; 其他平台用檔案 (dev) 或記憶體, 並在 log 說明原因, 不崩潰。
export function createSecretStore({ dataDir, logger, prefer } = {}) {
  if (prefer === "memory") return new MemorySecretStore();
  if (process.platform === "win32" && prefer !== "file") {
    try { return new WindowsSecretStore({ logger }); }
    catch (e) { logger?.warn("機密存放", "認證管理員後端建立失敗, 改用檔案後端", { error: String(e?.message ?? e) }); }
  } else if (process.platform !== "win32") {
    logger?.info("機密存放", "目前不是 Windows, 認證管理員/DPAPI 停用, 改用 AES 檔案後端 (dev)", { platform: process.platform });
  }
  return new FileSecretStore({ path: `${dataDir}/secrets.dev.json` });
}
