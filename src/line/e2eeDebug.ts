import { createHash } from "node:crypto";

/**
 * Read-only E2EE diagnostics (debug build only; this module ships on the
 * debug/e2ee-trace branch and is never merged into the product branch).
 *
 * Every emitted line is a single `E2EE_DEBUG` record holding only ids,
 * key ids and SHA-256 fingerprints of *public* keys. Private keys, message
 * content, tokens and raw server payloads never reach the log (AGENTS.md
 * hard rules). The fingerprint construction matches the standalone
 * keycheck tool — SHA-256 over the raw public key bytes, first 16
 * uppercase hex chars — so values compare across tools.
 */

/** SHA-256 fingerprint of a public key's raw bytes (first 16 uppercase hex chars). */
export function pubKeyFingerprint(pubKey: Buffer): string {
  return createHash("sha256").update(pubKey).digest("hex").slice(0, 16).toUpperCase();
}

/** Last 4 characters of an id; full mids are never logged. */
export function idTail(id: string | undefined): string {
  if (!id) return "-";
  return id.length <= 4 ? id : id.slice(-4);
}

/** Big-endian key id from an E2EE envelope chunk, mirroring linejs' byte2int. */
export function envelopeKeyId(chunk: unknown): number | undefined {
  if (!(chunk instanceof Uint8Array)) return undefined;
  if (chunk.length === 0 || chunk.length > 8) return undefined;
  let value = 0;
  for (const byte of chunk) value = 256 * value + byte;
  return Number.isSafeInteger(value) ? value : undefined;
}

export interface EnvelopeKeyIds {
  senderKeyId?: number;
  receiverKeyId?: number;
}

/** chunks[3] / chunks[4] carry the sender / receiver key ids (the library's envelope layout). */
export function parseEnvelopeKeyIds(chunks: readonly unknown[] | undefined): EnvelopeKeyIds {
  if (!chunks || chunks.length < 5) return {};
  return { senderKeyId: envelopeKeyId(chunks[3]), receiverKeyId: envelopeKeyId(chunks[4]) };
}

/**
 * Suppresses repeated diagnostic lines: the first occurrence emits, repeats
 * inside the window are counted and reported when the line next emits.
 */
export class RepeatThrottle {
  private entries = new Map<string, { last: number; suppressed: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Returns how many repeats were suppressed since the last emit, or undefined to suppress this one. */
  check(key: string, windowMs: number): number | undefined {
    const at = this.now();
    const entry = this.entries.get(key);
    if (!entry || at - entry.last >= windowMs) {
      const repeats = entry?.suppressed ?? 0;
      this.entries.set(key, { last: at, suppressed: 0 });
      return repeats;
    }
    entry.suppressed += 1;
    return undefined;
  }
}

export interface DecryptTraceFacts {
  isGroup: boolean;
  isSelf: boolean;
  groupKeyBefore: boolean;
  groupKeyAfter: boolean;
  peerKeyBefore: boolean;
  peerKeyAfter: boolean;
  ok: boolean;
}

export interface DecryptTraceSummary {
  groupKeySource: "cache" | "fetched" | "absent" | "na";
  peerKeySource: "cache" | "fetched" | "absent" | "self" | "na";
  /** On failure, the stage the evidence points at; "-" on success. */
  step: "groupkey" | "senderkey" | "decrypt" | "-";
}

/**
 * Attributes a decrypt outcome from storage state observed around the call
 * (the unwrap itself happens inside the library; its inputs and outputs are
 * the cache entries it reads and writes):
 * - group key missing both before and after a failure: fetching/unwrapping it failed;
 * - group key fine but the peer's public key was never available: negotiation failed;
 * - both keys present yet decryption failed: the key *values* disagree (GCM auth).
 */
export function summarizeDecryptTrace(facts: DecryptTraceFacts): DecryptTraceSummary {
  const groupKeySource = !facts.isGroup ? "na"
    : facts.groupKeyBefore ? "cache"
    : facts.groupKeyAfter ? "fetched" : "absent";
  const peerKeySource = facts.isSelf ? "self"
    : facts.peerKeyBefore ? "cache"
    : facts.peerKeyAfter ? "fetched" : "absent";
  if (facts.ok) return { groupKeySource, peerKeySource, step: "-" };
  if (facts.isGroup && !facts.groupKeyBefore && !facts.groupKeyAfter) return { groupKeySource, peerKeySource, step: "groupkey" };
  if (!facts.isSelf && !facts.peerKeyBefore && !facts.peerKeyAfter) return { groupKeySource, peerKeySource, step: "senderkey" };
  return { groupKeySource, peerKeySource, step: "decrypt" };
}

export interface E2EEKeyAuditDeps {
  myMid: string;
  /** Full session snapshot (used once at login; only `e2ee*` entries are read). */
  getAll(): Promise<Record<string, unknown>>;
  /** The public key the server currently registers for this account under `keyId`, if any. */
  registeredKey(keyId: string): Promise<Buffer | undefined>;
  /** The library's own derive-and-compare (never reimplemented here). */
  verifyPair(privKey: Buffer, pubKey: Buffer): boolean;
}

export interface E2EEKeyAuditResult {
  /** `e2eePublicKeys:*` entry names seen in the snapshot (baseline for later cache-diffing). */
  publicKeyEntries: string[];
  /** False when the snapshot could not be read, so later diffs must not be trusted. */
  complete: boolean;
}

function parseKeyData(value: unknown): { keyId?: unknown; privKey?: unknown; pubKey?: unknown } | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const data: unknown = JSON.parse(value);
    return data && typeof data === "object" ? data as { keyId?: unknown; privKey?: unknown; pubKey?: unknown } : undefined;
  } catch {
    return undefined;
  }
}

function asKeyBuffer(value: unknown): Buffer | undefined {
  return typeof value === "string" && value ? Buffer.from(value, "base64") : undefined;
}

/**
 * Audits every stored self-key slot once after login: does the stored private
 * key pair with the stored public key, and with the key the server registers
 * under the same key id? Emits one `kind=keyslot` line per slot. The private
 * key is only ever handed to the library's verify function in memory.
 */
export async function auditE2EEKeySlots(deps: E2EEKeyAuditDeps, emit: (line: string) => void): Promise<E2EEKeyAuditResult> {
  let all: Record<string, unknown>;
  try {
    all = await deps.getAll();
  } catch {
    emit("E2EE_DEBUG v=1 kind=keyslot result=fail step=read");
    return { publicKeyEntries: [], complete: false };
  }
  const publicKeyEntries = Object.keys(all).filter((key) => key.startsWith("e2eePublicKeys:"));
  const slotNames = Object.keys(all).filter((key) => key.startsWith("e2eeKeys:")).sort();
  if (!slotNames.length) {
    emit("E2EE_DEBUG v=1 kind=keyslot result=none");
    return { publicKeyEntries, complete: true };
  }
  for (const name of slotNames) {
    const slot = name.slice("e2eeKeys:".length);
    const slotLabel = slot === deps.myMid ? "mid" : slot;
    const data = parseKeyData(all[name]);
    if (!data) {
      emit(`E2EE_DEBUG v=1 kind=keyslot slot=${slotLabel} result=fail step=parse`);
      continue;
    }
    const keyId = typeof data.keyId === "number" || typeof data.keyId === "string" ? String(data.keyId) : "-";
    // In-memory only: passed to the library's verify, never logged.
    const privKey = asKeyBuffer(data.privKey);
    const pubKey = asKeyBuffer(data.pubKey);
    const storedFp = pubKey ? pubKeyFingerprint(pubKey) : "-";
    let pairMatch = "unknown";
    if (privKey && pubKey) {
      try {
        pairMatch = deps.verifyPair(privKey, pubKey) ? "yes" : "no";
      } catch {
        pairMatch = "unknown";
      }
    }
    let serverFp = "-";
    let serverMatch = "unknown";
    if (keyId !== "-") {
      try {
        const registered = await deps.registeredKey(keyId);
        if (registered) {
          serverFp = pubKeyFingerprint(registered);
          if (privKey) {
            try {
              serverMatch = deps.verifyPair(privKey, registered) ? "yes" : "no";
            } catch {
              serverMatch = "unknown";
            }
          }
        }
      } catch {
        serverFp = "-";
        serverMatch = "unknown";
      }
    }
    emit(`E2EE_DEBUG v=1 kind=keyslot slot=${slotLabel} keyId=${keyId} storedFp=${storedFp} pairMatch=${pairMatch} serverMatch=${serverMatch} serverFp=${serverFp}`);
  }
  return { publicKeyEntries, complete: true };
}
