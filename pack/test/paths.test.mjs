// paths 模組測試：驗證資料目錄解析與各路徑欄位
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dataPaths, resolveDataDir } from '../launcher/paths.mjs';

test('resolveDataDir：HWLINEHELPER_HOME 有值時最優先', () => {
  const custom = join('D:', 'custom-home-12345');
  assert.equal(
    resolveDataDir({ HWLINEHELPER_HOME: custom, LOCALAPPDATA: 'C:\\Ignored' }, 'win32'),
    custom,
  );
  assert.equal(
    resolveDataDir({ HWLINEHELPER_HOME: custom }, 'linux'),
    custom,
  );
});

test('resolveDataDir：win32 使用 LOCALAPPDATA', () => {
  const local = join('C:', 'Users', 'tester', 'AppData', 'Local');
  assert.equal(
    resolveDataDir({ LOCALAPPDATA: local }, 'win32'),
    join(local, 'HwLineHelper'),
  );
});

test('resolveDataDir：win32 無 LOCALAPPDATA 時退回使用者目錄', () => {
  assert.equal(
    resolveDataDir({}, 'win32'),
    join(homedir(), 'AppData', 'Local', 'HwLineHelper'),
  );
  assert.equal(
    resolveDataDir({ LOCALAPPDATA: '' }, 'win32'),
    join(homedir(), 'AppData', 'Local', 'HwLineHelper'),
  );
});

test('resolveDataDir：非 win32 退回使用者目錄下的隱藏目錄', () => {
  assert.equal(resolveDataDir({}, 'linux'), join(homedir(), '.hw-line-helper'));
  assert.equal(resolveDataDir({}, 'darwin'), join(homedir(), '.hw-line-helper'));
});

test('dataPaths：各欄位正確', () => {
  const root = join('some', 'data-dir');
  const p = dataPaths(root);
  assert.equal(p.root, root);
  assert.equal(p.configFile, join(root, 'config.yaml'));
  assert.equal(p.sessionFile, join(root, 'session.json'));
  assert.equal(p.sessionEncrypted, join(root, 'session.json.dpapi'));
  assert.equal(p.apiTokenFile, join(root, 'api-token.json'));
  assert.equal(p.pidFile, join(root, 'linejs.pid'));
  assert.equal(p.logsDir, join(root, 'logs'));
  assert.equal(p.runtimeDir, join(root, 'runtime'));
  assert.equal(p.distWebDir, join(root, 'dist', 'web'));
});
