// dpapi 模組測試：只驗證命令組裝，不實際執行 PowerShell
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DPAPI_ENV_IN,
  DPAPI_ENV_OUT,
  buildDpapiCommand,
} from '../launcher/dpapi.mjs';

const IN_FILE = 'C:\\fake-unique-in-12345\\session.json.dpapi';
const OUT_FILE = 'C:\\fake-unique-out-67890\\session.json';

function scriptOf(cmd) {
  return cmd.args[cmd.args.length - 1];
}

test('常數值正確', () => {
  assert.equal(DPAPI_ENV_IN, 'HW_DPAPI_IN');
  assert.equal(DPAPI_ENV_OUT, 'HW_DPAPI_OUT');
});

test('buildDpapiCommand protect：命令組裝正確', () => {
  const cmd = buildDpapiCommand('protect', IN_FILE, OUT_FILE);
  assert.equal(cmd.file, 'powershell.exe');
  assert.deepEqual(cmd.args.slice(0, 5), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
  ]);
  assert.equal(cmd.args.length, 6);
  const script = scriptOf(cmd);
  assert.ok(script.includes('System.Security'));
  assert.ok(script.includes('ProtectedData'));
  assert.ok(script.includes('::Protect('));
  assert.ok(!script.includes('::Unprotect('));
  assert.ok(script.includes('CurrentUser'));
  assert.ok(script.includes('ReadAllBytes'));
  assert.ok(script.includes('WriteAllBytes'));
  assert.ok(script.includes('$env:HW_DPAPI_IN'));
  assert.ok(script.includes('$env:HW_DPAPI_OUT'));
  assert.equal(cmd.env.HW_DPAPI_IN, IN_FILE);
  assert.equal(cmd.env.HW_DPAPI_OUT, OUT_FILE);
  assert.equal(cmd.env[DPAPI_ENV_IN], IN_FILE);
  assert.equal(cmd.env[DPAPI_ENV_OUT], OUT_FILE);
});

test('buildDpapiCommand unprotect：命令組裝正確', () => {
  const cmd = buildDpapiCommand('unprotect', IN_FILE, OUT_FILE);
  assert.equal(cmd.file, 'powershell.exe');
  const script = scriptOf(cmd);
  assert.ok(script.includes('ProtectedData'));
  assert.ok(script.includes('::Unprotect('));
  assert.ok(script.includes('CurrentUser'));
  assert.equal(cmd.env.HW_DPAPI_IN, IN_FILE);
  assert.equal(cmd.env.HW_DPAPI_OUT, OUT_FILE);
});

test('buildDpapiCommand：script 不含傳入的實際路徑字串', () => {
  for (const mode of ['protect', 'unprotect']) {
    const cmd = buildDpapiCommand(mode, IN_FILE, OUT_FILE);
    const script = scriptOf(cmd);
    assert.ok(!script.includes(IN_FILE), `${mode} script 不得含輸入路徑`);
    assert.ok(!script.includes(OUT_FILE), `${mode} script 不得含輸出路徑`);
    assert.ok(!script.includes('fake-unique-in-12345'));
    assert.ok(!script.includes('fake-unique-out-67890'));
  }
});

test('buildDpapiCommand：非法 mode throw', () => {
  assert.throws(() => buildDpapiCommand('encrypt', IN_FILE, OUT_FILE));
  assert.throws(() => buildDpapiCommand('', IN_FILE, OUT_FILE));
  assert.throws(() => buildDpapiCommand(undefined, IN_FILE, OUT_FILE));
});
