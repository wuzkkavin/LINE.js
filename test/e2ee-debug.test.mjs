import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  auditE2EEKeySlots,
  envelopeKeyId,
  idTail,
  parseEnvelopeKeyIds,
  pubKeyFingerprint,
  RepeatThrottle,
  summarizeDecryptTrace,
} from "../dist/line/e2eeDebug.js";

const LINE_FORMAT = /^E2EE_DEBUG v=1 kind=[a-z]+( [a-zA-Z]+=[^ ]+)+$/;

test("pubKeyFingerprint matches the keycheck tool construction (sha256, first 16 uppercase hex)", () => {
  // Well-known SHA-256 vectors.
  assert.equal(pubKeyFingerprint(Buffer.from("abc")), "BA7816BF8F01CFEA");
  assert.equal(pubKeyFingerprint(Buffer.alloc(0)), "E3B0C44298FC1C14");
  const key = Buffer.alloc(32, 7);
  const expected = createHash("sha256").update(key).digest("hex").slice(0, 16).toUpperCase();
  assert.equal(pubKeyFingerprint(key), expected);
});

test("idTail never exposes a full id", () => {
  assert.equal(idTail("cda31468aa860cece31999c0b4e8be39d"), "e39d");
  assert.equal(idTail("u123"), "u123");
  assert.equal(idTail(undefined), "-");
  assert.equal(idTail(""), "-");
});

test("envelopeKeyId mirrors byte2int and rejects non-envelope chunks", () => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(5963209);
  assert.equal(envelopeKeyId(buf), 5963209);
  buf.writeUInt32BE(178007062);
  assert.equal(envelopeKeyId(new Uint8Array(buf)), 178007062);
  assert.equal(envelopeKeyId("5963209"), undefined);
  assert.equal(envelopeKeyId(Buffer.alloc(0)), undefined);
  assert.equal(envelopeKeyId(Buffer.alloc(9)), undefined);
  assert.equal(envelopeKeyId(undefined), undefined);
});

test("parseEnvelopeKeyIds reads chunks[3] and chunks[4] only when present", () => {
  const id = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  assert.deepEqual(parseEnvelopeKeyIds([Buffer.alloc(1), Buffer.alloc(1), Buffer.alloc(1), id(11), id(22)]), { senderKeyId: 11, receiverKeyId: 22 });
  assert.deepEqual(parseEnvelopeKeyIds([Buffer.alloc(1), Buffer.alloc(1)]), {});
  assert.deepEqual(parseEnvelopeKeyIds(undefined), {});
});

test("RepeatThrottle emits first, suppresses inside the window, then reports the repeat count", () => {
  let now = 1_000_000;
  const throttle = new RepeatThrottle(() => now);
  assert.equal(throttle.check("k", 60_000), 0);
  assert.equal(throttle.check("k", 60_000), undefined);
  assert.equal(throttle.check("k", 60_000), undefined);
  now += 59_999;
  assert.equal(throttle.check("k", 60_000), undefined);
  now += 1;
  assert.equal(throttle.check("k", 60_000), 3);
  assert.equal(throttle.check("other", 60_000), 0);
});

test("summarizeDecryptTrace attributes the failing stage from cache facts", () => {
  const base = { isGroup: true, isSelf: false, groupKeyBefore: false, groupKeyAfter: false, peerKeyBefore: false, peerKeyAfter: false, ok: false };
  // Group key never materialised: the fetch/unwrap stage failed.
  assert.deepEqual(summarizeDecryptTrace(base), { groupKeySource: "absent", peerKeySource: "absent", step: "groupkey" });
  // Group key fetched during the call, sender key still missing: negotiation failed.
  assert.deepEqual(summarizeDecryptTrace({ ...base, groupKeyAfter: true }), { groupKeySource: "fetched", peerKeySource: "absent", step: "senderkey" });
  // Both keys present, still failed: the key values disagree (GCM auth stage).
  assert.deepEqual(summarizeDecryptTrace({ ...base, groupKeyBefore: true, peerKeyBefore: true }),
    { groupKeySource: "cache", peerKeySource: "cache", step: "decrypt" });
  // Self-sent group message with the group key present: only the decrypt stage remains.
  assert.deepEqual(summarizeDecryptTrace({ ...base, isSelf: true, groupKeyBefore: true }),
    { groupKeySource: "cache", peerKeySource: "self", step: "decrypt" });
  // Success reports no failing stage.
  assert.deepEqual(summarizeDecryptTrace({ ...base, ok: true, groupKeyBefore: true, peerKeyBefore: true }),
    { groupKeySource: "cache", peerKeySource: "cache", step: "-" });
  // One-to-one chats have no group key stage.
  assert.deepEqual(summarizeDecryptTrace({ ...base, isGroup: false, peerKeyAfter: true }),
    { groupKeySource: "na", peerKeySource: "fetched", step: "decrypt" });
});

const PRIV_A = Buffer.alloc(32, 0x11);
const PUB_A = Buffer.alloc(32, 0x22);
const PUB_B = Buffer.alloc(32, 0x33);

function slotJson(keyId, privKey, pubKey) {
  return JSON.stringify({ keyId, privKey: privKey.toString("base64"), pubKey: pubKey.toString("base64"), e2eeVersion: 2 });
}

function auditDeps(all, { registered, pairWith } = {}) {
  return {
    myMid: "u" + "a".repeat(32),
    getAll: async () => all,
    registeredKey: async (keyId) => registered?.(keyId),
    // Test double for the library's derive-and-compare: a pair matches when
    // the public key is the one registered for that private key in `pairWith`.
    verifyPair: (privKey, pubKey) => pairWith ? pubKey.equals(pairWith(privKey)) : privKey.equals(pubKey),
  };
}

test("auditE2EEKeySlots reports matching slots with fingerprints only", async () => {
  const myMid = "u" + "a".repeat(32);
  const all = {
    [`e2eeKeys:${myMid}`]: slotJson(6071424, PRIV_A, PUB_A),
    "e2eeKeys:6071424": slotJson(6071424, PRIV_A, PUB_A),
    [`e2eePublicKeys:${myMid}:6071424`]: PUB_A.toString("base64"),
    "userAuthToken": "must-never-appear",
  };
  const lines = [];
  const result = await auditE2EEKeySlots(auditDeps(all, {
    registered: async () => PUB_A,
    pairWith: () => PUB_A,
  }), (line) => lines.push(line));
  assert.equal(result.complete, true);
  assert.deepEqual(result.publicKeyEntries, [`e2eePublicKeys:${myMid}:6071424`]);
  assert.equal(lines.length, 2);
  const fp = pubKeyFingerprint(PUB_A);
  for (const line of lines) {
    assert.match(line, LINE_FORMAT);
    assert.ok(line.includes(`storedFp=${fp}`), line);
    assert.ok(line.includes("pairMatch=yes"), line);
    assert.ok(line.includes("serverMatch=yes"), line);
    assert.ok(line.includes(`serverFp=${fp}`), line);
    // No key material, no base64 of either key, no token — fingerprints only.
    assert.ok(!line.includes(PRIV_A.toString("base64")), line);
    assert.ok(!line.includes(PUB_A.toString("base64")), line);
    assert.ok(!line.includes("must-never-appear"), line);
  }
  assert.ok(lines.some((line) => line.includes("slot=mid")));
  assert.ok(lines.some((line) => line.includes("slot=6071424")));
});

test("auditE2EEKeySlots names a mismatched pair and a server disagreement separately", async () => {
  const myMid = "u" + "a".repeat(32);
  const all = { [`e2eeKeys:${myMid}`]: slotJson(6071424, PRIV_A, PUB_B) };
  const lines = [];
  await auditE2EEKeySlots(auditDeps(all, {
    registered: async () => PUB_A,
    pairWith: () => PUB_A,
  }), (line) => lines.push(line));
  assert.equal(lines.length, 1);
  // Stored pub (PUB_B) differs from what the private key derives (PUB_A) and
  // from the server's registration (PUB_A): pairMatch=no, serverMatch=yes.
  assert.ok(lines[0].includes("pairMatch=no"), lines[0]);
  assert.ok(lines[0].includes("serverMatch=yes"), lines[0]);
  assert.ok(lines[0].includes(`storedFp=${pubKeyFingerprint(PUB_B)}`), lines[0]);
  assert.ok(lines[0].includes(`serverFp=${pubKeyFingerprint(PUB_A)}`), lines[0]);
});

test("auditE2EEKeySlots stays honest when the server has no key or storage is broken", async () => {
  const myMid = "u" + "a".repeat(32);
  const lines = [];
  await auditE2EEKeySlots(auditDeps({ [`e2eeKeys:${myMid}`]: slotJson(1, PRIV_A, PUB_A) }, {
    registered: async () => undefined,
    pairWith: () => PUB_A,
  }), (line) => lines.push(line));
  assert.ok(lines[0].includes("serverMatch=unknown"), lines[0]);
  assert.ok(lines[0].includes("serverFp=-"), lines[0]);

  const broken = [];
  const result = await auditE2EEKeySlots({
    myMid,
    getAll: async () => { throw new Error("nope"); },
    registeredKey: async () => undefined,
    verifyPair: () => true,
  }, (line) => broken.push(line));
  assert.deepEqual(broken, ["E2EE_DEBUG v=1 kind=keyslot result=fail step=read"]);
  assert.equal(result.complete, false);

  const garbage = [];
  await auditE2EEKeySlots(auditDeps({ "e2eeKeys:6071424": "{not json" }), (line) => garbage.push(line));
  assert.deepEqual(garbage, ["E2EE_DEBUG v=1 kind=keyslot slot=6071424 result=fail step=parse"]);

  const empty = [];
  await auditE2EEKeySlots(auditDeps({}), (line) => empty.push(line));
  assert.deepEqual(empty, ["E2EE_DEBUG v=1 kind=keyslot result=none"]);
});
