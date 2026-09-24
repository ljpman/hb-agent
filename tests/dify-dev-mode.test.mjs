import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { DIFY_ENV_VARS } from '../server/dify/dify-client.mjs';

function runApp(overrides = {}, scriptBody = `
  import { createApp } from './server/index.mjs';
  try {
    const app = createApp({ database: ':memory:', tick: false });
    console.log(JSON.stringify({ started: true, status: app.service.dify.status(), edition: app.edition || null }));
    app.store.close();
  } catch (error) { console.log(JSON.stringify({ started: false, code: error.code })); }
`) {
  const env = { ...process.env, NODE_ENV: 'test' };
  for (const name of [...DIFY_ENV_VARS, 'HB_DIFY_MODE', 'HB_STRICT_MODE']) delete env[name];
  Object.assign(env, overrides);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', scriptBody], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('M2a 默认离线：任何 Dify 变量仍被拒绝；dev 模式拒绝非本机地址', () => {
  for (const name of DIFY_ENV_VARS) {
    const value = name === 'DIFY_API_URL' ? 'http://localhost/v1' : 'offline-test-key-0001';
    assert.deepEqual(runApp({ [name]: value }), { started: false, code: 'DIFY_OFFLINE_ONLY' }, name);
  }
  assert.deepEqual(runApp({ HB_DIFY_MODE: 'dev', DIFY_API_URL: 'https://dify.example/v1', DIFY_CHAT_API_KEY: 'offline-chat-key-0001' }),
    { started: false, code: 'DIFY_URL_NOT_LOCAL' });
});

test('production 和严格模式拒绝 Dify 联调配置', () => {
  assert.deepEqual(runApp({ HB_STRICT_MODE: 'true', HB_DIFY_MODE: 'dev', DIFY_API_URL: 'http://localhost/v1' }),
    { started: false, code: 'DIFY_STRICT_ONLY' });
  assert.deepEqual(runApp({ HB_STRICT_MODE: 'true', DIFY_CHAT_API_KEY: 'offline-chat-key-0001' }),
    { started: false, code: 'DIFY_STRICT_ONLY' });
});

test('显式 dev 模式仅用 localhost 并按三个应用独立 key 配置，bootstrap 标为 M2b 开发联调版', () => {
  const outcome = runApp({
    HB_DIFY_MODE: 'dev', DIFY_API_URL: 'http://127.0.0.1:5001/v1',
    DIFY_CHAT_API_KEY: 'offline-chat-key-0001', DIFY_EXTRACT_API_KEY: 'offline-extract-key-0002',
    DIFY_COMPLIANCE_API_KEY: 'offline-compliance-key-0003',
  }, `
    import { createApp } from './server/index.mjs';
    const app = createApp({ database: ':memory:', tick: false });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = 'http://127.0.0.1:' + app.server.address().port;
      const session = await fetch(origin + '/api/demo/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'broker' }) });
      const cookie = session.headers.get('set-cookie');
      const boot = await fetch(origin + '/api/bootstrap', { headers: { cookie } });
      const payload = await boot.json();
      console.log(JSON.stringify({ started: true, status: app.service.dify.status(), edition: payload.edition, mode: payload.integrations.difyMode, extraction: payload.integrations.difyExtraction }));
    } finally { await app.close(); }
  `);
  assert.equal(outcome.started, true);
  assert.equal(outcome.status.dify, 'configured');
  assert.equal(outcome.edition, 'M2b 开发联调版');
  assert.equal(outcome.mode, 'development');
  assert.equal(outcome.extraction, 'disabled');
});

test('Dify 参数抽取仅在开发模式显式 opt-in，缺独立 extract key 或开关值无效时拒绝', () => {
  const base = {
    HB_DIFY_MODE: 'dev', DIFY_API_URL: 'http://127.0.0.1:5001/v1',
    DIFY_CHAT_API_KEY: 'offline-chat-key-0001', DIFY_EXTRACT_API_KEY: 'offline-extract-key-0002',
    DIFY_COMPLIANCE_API_KEY: 'offline-compliance-key-0003',
  };
  const enabled = runApp({ ...base, HB_DIFY_EXTRACT_MODE: 'dev' }, `
    import { createApp } from './server/index.mjs';
    const app = createApp({ database: ':memory:', tick: false });
    console.log(JSON.stringify({ started: true, enabled: app.service.difyExtractEnabled }));
    app.store.close();
  `);
  assert.deepEqual(enabled, { started: true, enabled: true });
  assert.deepEqual(runApp({ ...base, DIFY_EXTRACT_API_KEY: undefined, HB_DIFY_EXTRACT_MODE: 'dev' }),
    { started: false, code: 'DIFY_EXTRACT_CONFIG_INVALID' });
  assert.deepEqual(runApp({ ...base, HB_DIFY_EXTRACT_MODE: 'true' }),
    { started: false, code: 'DIFY_EXTRACT_MODE_INVALID' });
  assert.deepEqual(runApp({ HB_DIFY_MODE: 'dev', HB_STRICT_MODE: 'true', HB_DIFY_EXTRACT_MODE: 'dev' }),
    { started: false, code: 'DIFY_STRICT_ONLY' });
});
