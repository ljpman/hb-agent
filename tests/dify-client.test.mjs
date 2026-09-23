import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { spawnSync } from 'node:child_process';

import { product } from '../server/catalog.mjs';
import { createDifyClient, HttpDifyClient, DIFY_APPS, DIFY_APP_KEY_ENV, DIFY_ENV_VARS } from '../server/dify/dify-client.mjs';
import { LocalFallbackDifyClient } from '../server/dify/local-fallback.mjs';

// Offline contract tests only: every HttpDifyClient here gets an injected transport.
// Placeholder values below are not real keys and the URL is a reserved .invalid host.
const apiUrl = 'https://dify.invalid/v1/';
const keys = { chat: 'offline-chat-key-0001', extract: 'offline-extract-key-0002', compliance: 'offline-compliance-key-0003' };
const user = 'dify-user-backend-0001';
const apps = Object.keys(DIFY_APPS);

function recorder(response = {}) {
  const calls = [];
  const transport = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return typeof response === 'function' ? response(url, init) : response; };
  return { calls, transport };
}
const call = {
  chat: client => client.chat({ text: '生成流程是什么', product, user }),
  extract: client => client.extractParams({ text: '陈先生35岁', product, user }),
  compliance: client => client.reviewCompliance({ draftReply: '请核对参数。', intent: 'answer', productId: product.id, user }),
};
const rejectsWith = (promise, code) => assert.rejects(promise, error => error.code === code);

test('按应用区分 key：chat／参数抽取／合规审查各用各自 key，且只在 Authorization 头（RL-06）', async () => {
  const { calls, transport } = recorder({ answer: 'ok', data: { outputs: { decision: 'allow', rules: [] } } });
  const client = createDifyClient({ apiUrl, apiKeys: keys, transport });
  assert.ok(client instanceof HttpDifyClient);
  assert.deepEqual(client.status(), { dify: 'configured', apps: { chat: 'configured', extract: 'configured', compliance: 'configured' } });
  for (const app of apps) await call[app](client);
  assert.deepEqual(calls.map(c => c.url), ['https://dify.invalid/v1/chat-messages', 'https://dify.invalid/v1/workflows/run', 'https://dify.invalid/v1/workflows/run']);
  apps.forEach((app, i) => {
    const { init, body } = calls[i];
    assert.equal(init.headers.Authorization, `Bearer ${keys[app]}`, app);
    assert.equal(init.method, 'POST');
    for (const key of Object.values(keys)) assert.ok(!init.body.includes(key), `${app} body must not carry any key`);
    assert.equal(body.user, user, 'user comes from the backend mapping');
  });
  assert.equal(calls[0].body.query, '生成流程是什么');
  assert.deepEqual(calls[1].body.inputs, { product_id: product.id, schema_version: product.schemaVersion, text: '陈先生35岁' });
  assert.deepEqual(calls[2].body.inputs, { draft_reply: '请核对参数。', intent: 'answer', product_id: product.id, channel: 'app' });
});

test('RL-04c：三个应用一律 blocking 模式并带超时信号，后端收齐完整回复后才审查', async () => {
  const { calls, transport } = recorder({ answer: 'ok', data: { outputs: { decision: 'allow' } } });
  const client = createDifyClient({ apiUrl, apiKeys: keys, transport, timeoutMs: 5000 });
  for (const app of apps) await call[app](client);
  for (const { body, init } of calls) {
    assert.equal(body.response_mode, 'blocking');
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test('缺某个应用的 key：该能力如实报未配置，不拿其他应用的 key 顶替，也不发起请求（RL-07）', async () => {
  // Every non-empty strict subset of the three apps.
  for (let mask = 1; mask < 7; mask++) {
    const present = apps.filter((_, i) => mask & (1 << i));
    const { calls, transport } = recorder({ answer: 'ok', data: { outputs: { decision: 'allow' } } });
    const client = createDifyClient({ apiUrl, apiKeys: Object.fromEntries(present.map(app => [app, keys[app]])), transport });
    const status = client.status();
    assert.equal(status.dify, 'partially-configured', present.join());
    for (const app of apps) {
      assert.equal(status.apps[app], present.includes(app) ? 'configured' : 'not-configured');
      const before = calls.length;
      if (present.includes(app)) {
        await call[app](client);
        assert.equal(calls.at(-1).init.headers.Authorization, `Bearer ${keys[app]}`, `${app} uses only its own key`);
      } else {
        await assert.rejects(call[app](client), error => error.code === 'DIFY_APP_NOT_CONFIGURED' && error.status === 503 && error.message.includes(DIFY_APPS[app]));
        assert.equal(calls.length, before, `${app} without its key must not call Dify`);
      }
    }
    for (const { init } of calls) {
      const used = init.headers.Authorization.slice('Bearer '.length);
      assert.ok(present.some(app => keys[app] === used));
    }
  }
});

test('配置校验：拒绝单一共享 key、重复 key、未知应用与非法 key；错误信息不含 key 值', () => {
  const secretish = 'offline-shared-key-0009';
  const cases = [
    [{ apiUrl, apiKey: secretish }, 'DIFY_KEY_AMBIGUOUS'],
    [{ apiUrl, apiKey: secretish, apiKeys: keys }, 'DIFY_KEY_AMBIGUOUS'],
    [{ apiUrl, apiKeys: { chat: secretish, extract: secretish } }, 'DIFY_KEY_REUSED'],
    [{ apiUrl, apiKeys: { chat: secretish, compliance: secretish, extract: keys.extract } }, 'DIFY_KEY_REUSED'],
    [{ apiUrl, apiKeys: { chat: keys.chat, assistant: secretish } }, 'DIFY_CONFIG_INVALID'],
    [{ apiUrl, apiKeys: { chat: 'short' } }, 'DIFY_CONFIG_INVALID'],
    [{ apiUrl, apiKeys: { chat: `${secretish}\nX-Injected: 1` } }, 'DIFY_CONFIG_INVALID'],
    [{ apiUrl, apiKeys: { chat: 12345678901 } }, 'DIFY_CONFIG_INVALID'],
  ];
  for (const [options, code] of cases) {
    assert.throws(() => createDifyClient(options), error => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes(secretish) && !error.message.includes('short'));
      return true;
    });
  }
  // Without a URL or without any key the backend stays on the honest local engine.
  for (const options of [{}, { apiUrl }, { apiUrl, apiKeys: {} }, { apiUrl, apiKeys: { chat: '', extract: null } }, { apiKeys: keys }]) {
    const client = createDifyClient(options);
    assert.ok(client instanceof LocalFallbackDifyClient);
    assert.equal(client.status().dify, 'not-configured');
  }
});

test('key 不出现在 JSON、inspect、status 与传输失败的错误中（RL-06）', async () => {
  const leaky = async (url, init) => { throw new Error(`upstream rejected ${init.headers.Authorization} for ${url}`); };
  const client = createDifyClient({ apiUrl, apiKeys: keys, transport: leaky });
  const views = [JSON.stringify(client), inspect(client, { showHidden: true, depth: 10 }), JSON.stringify(client.status())];
  for (const app of ['chat', 'extract']) {
    await assert.rejects(call[app](client), error => { views.push(error.message, JSON.stringify(error), inspect(error)); return error.code === 'DIFY_UNAVAILABLE' && error.status === 502; });
  }
  for (const view of views) for (const key of Object.values(keys)) assert.ok(!view.includes(key), view);
});

test('user 必须由后端提供；缺失或非法时不调用 Dify', async () => {
  const { calls, transport } = recorder({ answer: 'ok' });
  const client = createDifyClient({ apiUrl, apiKeys: keys, transport });
  for (const bad of [undefined, '', 'user with space', 'x'.repeat(101), { id: 'a' }]) {
    await rejectsWith(client.chat({ text: '你好', product, user: bad }), 'DIFY_USER_REQUIRED');
    await rejectsWith(client.extractParams({ text: '你好', product, user: bad }), 'DIFY_USER_REQUIRED');
    await rejectsWith(client.reviewCompliance({ draftReply: '你好', user: bad }), 'DIFY_USER_REQUIRED');
  }
  assert.equal(calls.length, 0);
});

test('远端抽取结果仍要求经纪确认，并如实标注来自 Dify（RL-03、RL-07）', async () => {
  const { transport } = recorder({ data: { outputs: { params: { age: 35 }, evidence: { age: '35岁' }, missing: ['gender'], conflicts: [] } } });
  const client = createDifyClient({ apiUrl, apiKeys: { extract: keys.extract }, transport });
  const result = await client.extractParams({ text: '陈先生35岁', product, user });
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.engine, 'dify');
  assert.equal(result.isMock, false);
  const local = createDifyClient().extractParams({ text: '陈先生35岁', product });
  assert.equal(local.engine, 'local-rule-demo');
  assert.equal(local.isMock, true);
  assert.match(local.warning, /未调用 Dify/);
});

test('C01／RL-04d：语义合规审查只作建议——异常、未知、不可用一律 block，改写后再跑确定性规则', async () => {
  const review = async (outputs, transport) => {
    const client = createDifyClient({ apiUrl, apiKeys: { compliance: keys.compliance }, transport: transport || (async () => ({ data: { outputs } })) });
    return client.reviewCompliance({ draftReply: '候选回复', user });
  };
  assert.deepEqual(await review({ decision: 'allow', rules: [] }), { decision: 'allow', rules: [], reply: null, engine: 'dify' });
  assert.equal((await review({ decision: 'block', rules: ['personalised-advice'] })).decision, 'block');
  for (const outputs of [{ decision: 'maybe' }, {}, { decision: 'ALLOW' }, null]) {
    const verdict = await review(outputs);
    assert.equal(verdict.decision, 'block', JSON.stringify(outputs));
    assert.ok(verdict.rules.includes('semantic-review-invalid'));
  }
  // RL-04d: compliance app timeout / outage never releases the candidate.
  const timeout = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  assert.deepEqual(await review(null, timeout), { decision: 'block', rules: ['semantic-review-unavailable'], reply: null, engine: 'dify' });
  // C01: a rewrite that still hits deterministic rules (or carries an unverified number) is blocked.
  for (const reply of ['这款产品保证赚，绝对安全。', '预计收益约 5%。', '保额壹佰萬。', '客户 AB987654(3) 已登记。', '', 42, 'x'.repeat(3001)]) {
    const verdict = await review({ decision: 'rewrite', reply, rules: ['promise-language'] });
    assert.equal(verdict.decision, 'block', String(reply));
    assert.equal(verdict.reply, null);
    assert.ok(verdict.rules.includes('rewrite-rejected'));
  }
  const rewritten = await review({ decision: 'rewrite', reply: '具体利益以保司官方计划书为准，请经纪核对。', rules: ['promise-language', '<script>'] });
  assert.deepEqual(rewritten, { decision: 'rewrite', rules: ['promise-language'], reply: '具体利益以保司官方计划书为准，请经纪核对。', engine: 'dify' });
  // Missing compliance app: reported as not configured, never as a verdict.
  await rejectsWith(createDifyClient({ apiUrl, apiKeys: { chat: keys.chat }, transport: async () => ({}) }).reviewCompliance({ draftReply: 'x', user }), 'DIFY_APP_NOT_CONFIGURED');
  assert.throws(() => new LocalFallbackDifyClient().reviewCompliance({ draftReply: 'x', user }), error => error.code === 'DIFY_APP_NOT_CONFIGURED');
});

test('M2b 预留的环境变量名：每个应用各一个 key 变量，统一列入拒绝清单', () => {
  assert.deepEqual(DIFY_APP_KEY_ENV, { chat: 'DIFY_CHAT_API_KEY', extract: 'DIFY_EXTRACT_API_KEY', compliance: 'DIFY_COMPLIANCE_API_KEY' });
  assert.deepEqual([...DIFY_ENV_VARS].sort(), ['DIFY_API_KEY', 'DIFY_API_URL', 'DIFY_CHAT_API_KEY', 'DIFY_COMPLIANCE_API_KEY', 'DIFY_EXTRACT_API_KEY']);
});

// Spawns the real application entry with one reserved Dify variable set and no network.
function startWith(name) {
  const script = `import { createApp } from './server/index.mjs';
    globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
    try { const app = createApp({ database: ':memory:', tick: false }); console.log(JSON.stringify({ started: true, dify: app.service.dify.status().dify })); app.store?.close?.(); }
    catch (error) { console.log(JSON.stringify({ started: false, code: error.code })); }`;
  const env = { ...process.env, NODE_ENV: 'test' };
  for (const key of DIFY_ENV_VARS) delete env[key];
  env[name] = name === 'DIFY_API_URL' ? 'https://dify.invalid/v1' : `offline-${name.toLowerCase()}-value`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('M2a-2 应用入口：任何按应用 key 变量都不会让应用接上真实 Dify', () => {
  for (const name of DIFY_ENV_VARS) {
    const outcome = startWith(name);
    // Either refused outright, or started strictly offline (the variable is never read).
    assert.ok(outcome.started ? outcome.dify === 'not-configured' : outcome.code === 'DIFY_OFFLINE_ONLY', `${name}: ${JSON.stringify(outcome)}`);
  }
});

test('M2a-2 应用入口：拒绝每一个预留的 Dify 环境变量', () => {
  for (const name of DIFY_ENV_VARS) assert.deepEqual(startWith(name), { started: false, code: 'DIFY_OFFLINE_ONLY' }, name);
});
