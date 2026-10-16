// vault 模組測試：用假 runCommand 模擬 DPAPI 轉換，不碰真 PowerShell
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dataPaths } from '../launcher/paths.mjs';
import { createSessionVault } from '../launcher/vault.mjs';

const PREFIX = 'ENC:';

function makeTempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'hw-vault-test-'));
  return { dir, paths: dataPaths(dir) };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// 假 runner：讀輸入檔，protect 時加前綴，unprotect 時去前綴，寫到輸出檔
function makeFakeRunner(calls) {
  return async (cmd) => {
    if (calls) calls.push(cmd);
    const inFile = cmd.env.HW_DPAPI_IN;
    const outFile = cmd.env.HW_DPAPI_OUT;
    const script = cmd.args[cmd.args.length - 1];
    const data = readFileSync(inFile, 'utf8');
    let out;
    if (script.includes('::Unprotect(')) {
      out = data.startsWith(PREFIX) ? data.slice(PREFIX.length) : data;
    } else if (script.includes('::Protect(')) {
      out = PREFIX + data;
    } else {
      throw new Error('假 runner 無法辨識 script');
    }
    writeFileSync(outFile, out, 'utf8');
    return { code: 0 };
  };
}

function makeFailingRunner() {
  return async () => {
    throw new Error('假 runner 模擬失敗');
  };
}

test('vault：unlock 解密成功', async () => {
  const { dir, paths } = makeTempPaths();
  try {
    writeFileSync(paths.sessionEncrypted, PREFIX + 'hello-session', 'utf8');
    const vault = createSessionVault({
      paths,
      platform: 'win32',
      runCommand: makeFakeRunner(),
    });
    const result = await vault.unlock();
    assert.deepEqual(result, { status: 'decrypted' });
    assert.equal(readFileSync(paths.sessionFile, 'utf8'), 'hello-session');
    assert.equal(readFileSync(paths.sessionEncrypted, 'utf8'), PREFIX + 'hello-session');
  } finally {
    cleanup(dir);
  }
});

test('vault：lock 加密成功並刪除明文', async () => {
  const { dir, paths } = makeTempPaths();
  try {
    writeFileSync(paths.sessionFile, 'plain-session', 'utf8');
    const vault = createSessionVault({
      paths,
      platform: 'win32',
      runCommand: makeFakeRunner(),
    });
    const result = await vault.lock();
    assert.deepEqual(result, { status: 'encrypted' });
    assert.equal(existsSync(paths.sessionFile), false);
    assert.equal(readFileSync(paths.sessionEncrypted, 'utf8'), PREFIX + 'plain-session');
    assert.equal(existsSync(paths.sessionEncrypted + '.tmp'), false);
  } finally {
    cleanup(dir);
  }
});

test('vault：lock 與 unlock 來回可還原原文', async () => {
  const { dir, paths } = makeTempPaths();
  try {
    const original = '{"token":"abc123","note":"繁體中文內容"}';
    writeFileSync(paths.sessionFile, original, 'utf8');
    const vault = createSessionVault({
      paths,
      platform: 'win32',
      runCommand: makeFakeRunner(),
    });
    assert.deepEqual(await vault.lock(), { status: 'encrypted' });
    assert.equal(existsSync(paths.sessionFile), false);
    assert.deepEqual(await vault.unlock(), { status: 'decrypted' });
    assert.equal(readFileSync(paths.sessionFile, 'utf8'), original);
  } finally {
    cleanup(dir);
  }
});

test('vault：unlock 無加密檔回 no-encrypted', async () => {
  const { dir, paths } = makeTempPaths();
  try {
    const vault = createSessionVault({
      paths,
      platform: 'win32',
      runCommand: makeFakeRunner(),
    });
    assert.deepEqual(await vault.unlock(), { status: 'no-encrypted' });
  } finally {
    cleanup(dir);
  }
});

test('vault：unlock 明文已存在時不覆蓋', async () => {
  const { dir, paths } = makeTempPaths();
  try {
    writeFileSync(paths.sessionEncrypted, PREFIX + 'encrypted-data', 'utf8');
    writeFileSync(paths.sessionFile, 'existing-plain', 'utf8');
    const calls = [];
    const vault = createSessionVault({
      paths,
      platform: 'win32',
      runCommand: makeFakeRunner(calls),
    });
    assert.deepEqual(await vault.unlock(), { status: 'plaintext-exists' });
    assert.equal(readFileSync(paths.sessionFile, 'utf8'), 'existing-plain');
    assert.equal(readFileSync(paths.sessionEncrypted, 'utf8'), PREFIX + 'encrypted-data');
    assert.equal(calls.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('vault：lock 無明文回 no-plaintext', async () => {
  const { dir, paths } = makeTempPaths();
  try {
    const vault = createSessionVault({
      paths,
      platform: 'win32',
      runCommand: makeFakeRunner(),
    });
    assert.deepEqual(await vault.lock(), { status: 'no-plaintext' });
  } finally {
    cleanup(dir);
  }
});

test('vault：lock 失敗保留明文且無殘留 tmp', async () => {
  const { dir, paths } = makeTempPaths();
  try {
    writeFileSync(paths.sessionFile, 'keep-me', 'utf8');
    writeFileSync(paths.sessionEncrypted, 'old-encrypted', 'utf8');
    const vault = createSessionVault({
      paths,
      platform: 'win32',
      runCommand: makeFailingRunner(),
    });
    await assert.rejects(
      () => vault.lock(),
      (err) => {
        assert.equal(err.code, 'DPAPI_LOCK_FAILED');
        return true;
      },
    );
    assert.equal(readFileSync(paths.sessionFile, 'utf8'), 'keep-me');
    assert.equal(readFileSync(paths.sessionEncrypted, 'utf8'), 'old-encrypted');
    assert.equal(existsSync(paths.sessionEncrypted + '.tmp'), false);
  } finally {
    cleanup(dir);
  }
});

test('vault：unlock 失敗保留密文', async () => {
  const { dir, paths } = makeTempPaths();
  try {
    writeFileSync(paths.sessionEncrypted, PREFIX + 'secret-data', 'utf8');
    const vault = createSessionVault({
      paths,
      platform: 'win32',
      runCommand: makeFailingRunner(),
    });
    await assert.rejects(
      () => vault.unlock(),
      (err) => {
        assert.equal(err.code, 'DPAPI_UNLOCK_FAILED');
        return true;
      },
    );
    assert.equal(readFileSync(paths.sessionEncrypted, 'utf8'), PREFIX + 'secret-data');
    assert.equal(existsSync(paths.sessionFile), false);
  } finally {
    cleanup(dir);
  }
});

test('vault：非 win32 平台跳過 unlock 與 lock', async () => {
  const { dir, paths } = makeTempPaths();
  try {
    writeFileSync(paths.sessionEncrypted, PREFIX + 'data', 'utf8');
    writeFileSync(paths.sessionFile, 'plain', 'utf8');
    const calls = [];
    const vault = createSessionVault({
      paths,
      platform: 'linux',
      runCommand: makeFakeRunner(calls),
    });
    assert.deepEqual(await vault.unlock(), { status: 'skipped-nonwindows' });
    assert.deepEqual(await vault.lock(), { status: 'skipped-nonwindows' });
    assert.equal(calls.length, 0);
    assert.equal(readFileSync(paths.sessionFile, 'utf8'), 'plain');
    assert.equal(readFileSync(paths.sessionEncrypted, 'utf8'), PREFIX + 'data');
  } finally {
    cleanup(dir);
  }
});
