// probe 模組測試：用本機暫時 HTTP 服務驗證探測，並驗證子程序規格組裝
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { buildChildSpec, probeHttp, waitForHttp } from '../launcher/probe.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('probeHttp：服務有回應時回 true，關閉後回 false', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  const port = await listen(server);
  try {
    assert.equal(await probeHttp({ port }), true);
    assert.equal(await probeHttp({ port, path: '/any-path' }), true);
  } finally {
    await close(server);
  }
  assert.equal(await probeHttp({ port, timeoutMs: 500 }), false);
});

test('probeHttp：任何狀態碼都算有回應', async () => {
  const server = createServer((req, res) => {
    res.writeHead(404);
    res.end('not found');
  });
  const port = await listen(server);
  try {
    assert.equal(await probeHttp({ port }), true);
  } finally {
    await close(server);
  }
});

test('waitForHttp：服務已就緒時回 true', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  const port = await listen(server);
  try {
    assert.equal(await waitForHttp({ port, timeoutMs: 3000, intervalMs: 50 }), true);
  } finally {
    await close(server);
  }
});

test('waitForHttp：逾時仍無服務時回 false', async () => {
  let calls = 0;
  const fakeProbe = async () => {
    calls += 1;
    return false;
  };
  const result = await waitForHttp({
    port: 9,
    timeoutMs: 200,
    intervalMs: 20,
    probe: fakeProbe,
  });
  assert.equal(result, false);
  assert.ok(calls >= 2);
});

test('waitForHttp：假 probe 後來成功時回 true', async () => {
  let calls = 0;
  const fakeProbe = async () => {
    calls += 1;
    return calls >= 3;
  };
  const result = await waitForHttp({
    port: 12345,
    timeoutMs: 3000,
    intervalMs: 10,
    probe: fakeProbe,
  });
  assert.equal(result, true);
  assert.equal(calls, 3);
});

test('buildChildSpec：core 角色', () => {
  const ctx = { exePath: 'C:\\app\\HwLineHelper.exe', dataDir: 'C:\\data\\HwLineHelper' };
  assert.deepEqual(buildChildSpec('core', ctx), {
    file: ctx.exePath,
    args: ['--role', 'core'],
    cwd: ctx.dataDir,
    env: {},
  });
});

test('buildChildSpec：helper 角色帶專用環境變數', () => {
  const ctx = { exePath: '/tmp/fake.exe', dataDir: '/tmp/data-dir' };
  assert.deepEqual(buildChildSpec('helper', ctx), {
    file: ctx.exePath,
    args: ['--role', 'helper'],
    cwd: ctx.dataDir,
    env: { HELPER_DATA_DIR: ctx.dataDir, HELPER_PORT: '3790' },
  });
});

test('buildChildSpec：cli 角色帶額外參數', () => {
  const ctx = {
    exePath: '/tmp/fake.exe',
    dataDir: '/tmp/data-dir',
    extraArgs: ['login', '--force'],
  };
  assert.deepEqual(buildChildSpec('cli', ctx), {
    file: ctx.exePath,
    args: ['--role', 'cli', 'login', '--force'],
    cwd: ctx.dataDir,
    env: {},
  });
  // extraArgs 省略時預設為空陣列
  assert.deepEqual(
    buildChildSpec('cli', { exePath: ctx.exePath, dataDir: ctx.dataDir }).args,
    ['--role', 'cli'],
  );
});

test('buildChildSpec：未知 role throw', () => {
  const ctx = { exePath: '/tmp/fake.exe', dataDir: '/tmp/data-dir' };
  assert.throws(() => buildChildSpec('unknown', ctx));
  assert.throws(() => buildChildSpec('', ctx));
});
