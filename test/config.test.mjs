import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { parse, stringify } from "yaml";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "linejs-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = parse(await readFile(new URL("../config.example.yaml", import.meta.url), "utf8"));
  config.server.port = 4567;
  await writeFile(join(root, "config.example.yaml"), stringify(config));
  return { root, config };
}

test("first-run config uses configured port; existing personal values take precedence", async (t) => {
  const { root, config } = await fixture(t);
  assert.equal((await loadConfig(root)).server.port, 4567);
  config.server.port = 6789;
  await writeFile(join(root, "config.yaml"), stringify(config));
  config.server.port = 7890;
  await writeFile(join(root, "config.example.yaml"), stringify(config));
  assert.equal((await loadConfig(root)).server.port, 6789);
});

test("HWLINE_CORE_PORT env overrides the file port; invalid env is ignored", async (t) => {
  const { root } = await fixture(t);
  const prev = process.env.HWLINE_CORE_PORT;
  try {
    process.env.HWLINE_CORE_PORT = "3811";
    assert.equal((await loadConfig(root)).server.port, 3811);
    process.env.HWLINE_CORE_PORT = "not-a-port";
    assert.equal((await loadConfig(root)).server.port, 4567);
    process.env.HWLINE_CORE_PORT = "70000";
    assert.equal((await loadConfig(root)).server.port, 4567);
  } finally {
    if (prev === undefined) delete process.env.HWLINE_CORE_PORT;
    else process.env.HWLINE_CORE_PORT = prev;
  }
});

test("limits above security ceilings and malformed hosts are rejected", async (t) => {
  const { root, config } = await fixture(t);
  for (const [section, key, value] of [
    ["server", "host", ""], ["server", "host", "evil host"], ["server", "host", "http://127.0.0.1"], ["server", "host", 3],
    ["limits", "frameMaxBytes", 262145], ["limits", "textMaxLength", 8001], ["limits", "uploadFileMaxBytes", 10485761], ["server", "port", 65536],
  ]) {
    const invalid = structuredClone(config);
    invalid[section][key] = value;
    await writeFile(join(root, "config.yaml"), stringify(invalid));
    await assert.rejects(loadConfig(root), /CONFIG_INVALID/);
  }
});

test("the browser file-upload limit defaults to 10 MiB and may only be lowered", async (t) => {
  const { root, config } = await fixture(t);
  assert.equal((await loadConfig(root)).limits.uploadFileMaxBytes, 10485760);
  const smaller = structuredClone(config);
  smaller.limits.uploadFileMaxBytes = 123456;
  await writeFile(join(root, "config.yaml"), stringify(smaller));
  assert.equal((await loadConfig(root)).limits.uploadFileMaxBytes, 123456);
  const omitted = structuredClone(config);
  delete omitted.limits.uploadFileMaxBytes;
  await writeFile(join(root, "config.yaml"), stringify(omitted));
  assert.equal((await loadConfig(root)).limits.uploadFileMaxBytes, 10485760, "configs written before the field existed keep working");
});

test("the listen address is whatever config.yaml says; the shipped default stays loopback", async (t) => {
  const { root, config } = await fixture(t);
  assert.equal(config.server.host, "127.0.0.1");
  for (const host of ["0.0.0.0", "192.168.1.20", "::1", "my-box.local"]) {
    await writeFile(join(root, "config.yaml"), stringify({ ...config, server: { ...config.server, host } }));
    assert.equal((await loadConfig(root)).server.host, host);
  }
});

test("the bot API is off by default and, once on, needs a non-empty list of valid chat ids", async (t) => {
  const { root, config } = await fixture(t);
  const chat = `c${"a".repeat(32)}`;
  const load = async (api) => {
    await writeFile(join(root, "config.yaml"), stringify({ ...config, api }));
    return loadConfig(root);
  };
  assert.deepEqual((await loadConfig(root)).api, { enabled: false, chats: [], sendsPerMinute: 20 });
  assert.deepEqual(await load({ enabled: true, chats: [chat, chat], sendsPerMinute: 5 }).then((c) => c.api), { enabled: true, chats: [chat], sendsPerMinute: 5 });
  for (const bad of [{ enabled: "yes" }, { enabled: true }, { enabled: true, chats: [] }, { enabled: true, chats: ["nope"] }, { enabled: true, chats: [chat], sendsPerMinute: 121 }]) {
    await assert.rejects(load(bad), /CONFIG_INVALID/);
  }
});

test("the scam check is off until a Jev token is set; tokens that cannot be a header value are rejected", async (t) => {
  const { root, config } = await fixture(t);
  const load = async (jev) => {
    await writeFile(join(root, "config.yaml"), stringify({ ...config, jev }));
    return loadConfig(root);
  };
  assert.equal((await loadConfig(root)).jev.token, undefined, "the shipped template has no token");
  assert.equal((await load(undefined)).jev.token, undefined, "configs written before the section existed keep the check disabled");
  assert.equal((await load({ token: null })).jev.token, undefined);
  assert.deepEqual((await load({ token: "ts_live_abc123", model: "jev-latest" })).jev, { token: "ts_live_abc123", model: "jev-latest" });
  for (const bad of [{ token: "has space" }, { token: "line\nbreak" }, { token: 42 }, { token: "x".repeat(513) }, { token: "ok", model: "jev 1" }, "token"]) {
    await assert.rejects(load(bad), /CONFIG_INVALID/, JSON.stringify(bad));
  }
});
