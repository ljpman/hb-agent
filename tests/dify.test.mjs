import assert from 'node:assert/strict';
import test from 'node:test';

import { demoActors, product } from '../server/catalog.mjs';
import { Service } from '../server/service.mjs';
import { Store } from '../server/store.mjs';
import { evaluateCompliance, COMPLIANCE_RULES } from '../server/dify/compliance.mjs';
import { createDifyClient, HttpDifyClient } from '../server/dify/dify-client.mjs';
import { LocalFallbackDifyClient } from '../server/dify/local-fallback.mjs';

function serviceWith(dify) {
  let clock = Date.parse('2026-09-22T01:00:00.000Z');
  const store = new Store(':memory:');
  const service = new Service(store, { now: () => clock, stepMs: 0, dify });
  return { service, store };
}

test('出口守卫：无来源收益数字被拦截（模型不产数字的出口落地）', () => {
  const v = evaluateCompliance({ text: '这款产品预计每年收益约 8%，长期回报可观。', citations: [] });
  assert.equal(v.decision, 'block');
  assert.ok(v.rules.includes(COMPLIANCE_RULES.UNSOURCED_NUMBER));
  // 同样的数字，只要有出处即可放行。
  const ok = evaluateCompliance({ text: '根据官方计划书第 3 页，现金价值为 12,345。', citations: ['官方计划书 · 第 3 页'] });
  assert.equal(ok.decision, 'allow');
});

test('出口守卫：承诺话术与敏感字段被拦截，正常回复放行', () => {
  assert.equal(evaluateCompliance({ text: '这款产品保证赚，绝对安全。' }).decision, 'block');
  assert.equal(evaluateCompliance({ text: '客户身份证 12345678901234567X 已登记。' }).decision, 'block');
  assert.equal(evaluateCompliance({ text: '已整理为待确认参数。请打开确认表单，补齐缺失项后提交。' }).decision, 'allow');
  const v = evaluateCompliance({ text: '这款产品保证赚，收益 20%。', citations: [] });
  assert.ok(v.rules.includes(COMPLIANCE_RULES.PROMISE));
  assert.ok(v.rules.includes(COMPLIANCE_RULES.UNSOURCED_NUMBER));
});

test('DifyClient：未配置时诚实降级到本地引擎，不伪称调用模型', () => {
  const client = createDifyClient();
  assert.ok(client instanceof LocalFallbackDifyClient);
  assert.equal(client.isConfigured, false);
  assert.equal(client.status().dify, 'not-configured');
  const extracted = client.extractParams({ text: '陈先生35岁不吸烟，年缴1万美元，5年缴', product });
  assert.equal(extracted.params.age, 35);
  assert.equal(extracted.params.smoker, false);
  assert.match(extracted.warning, /未调用 Dify/);
});

test('DifyClient：配置后走 HTTP，API key 只在请求头、user 由后端提供', async () => {
  let captured;
  const transport = async (url, init) => { captured = { url, init }; return { answer: 'ok', metadata: { intent: 'answer', source: '知识库' } }; };
  const client = createDifyClient({ apiUrl: 'https://dify.example/v1/', apiKey: 'app-secret-key', transport });
  assert.ok(client instanceof HttpDifyClient);
  assert.equal(client.status().dify, 'configured');
  await client.chat({ text: '你好', user: 'dify-internal-123' });
  assert.equal(captured.url, 'https://dify.example/v1/chat-messages');
  assert.equal(captured.init.headers.Authorization, 'Bearer app-secret-key');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.user, 'dify-internal-123');
  assert.equal(body.query, '你好');
  // The key must never travel in the request body.
  assert.ok(!captured.init.body.includes('app-secret-key'));
});

test('assistant：出口审查在返回前完成，违规回复被拦并记审计', () => {
  const badDify = {
    isConfigured: true,
    status: () => ({ dify: 'configured' }),
    chat: () => ({ kind: 'answer', answer: '这款产品保证赚，年收益 12%。', source: null, engine: 'dify' }),
    extractParams: () => ({}),
  };
  const { service, store } = serviceWith(badDify);
  const record = service.assistant(demoActors.broker, '这产品怎么样', null);
  assert.equal(record.blocked, true);
  assert.match(record.answer, /人工/);
  assert.equal(record.compliance.decision, 'block');
  const events = store.list('event', demoActors.broker);
  assert.ok(events.some(e => e.type === 'compliance.blocked'));
  store.close();
});

test('assistant：正常回复放行且带出处，抽取分支只给待确认参数', () => {
  const { service, store } = serviceWith(createDifyClient());
  const answer = service.assistant(demoActors.broker, '生成流程是什么样的', null);
  assert.equal(answer.blocked, undefined);
  assert.equal(answer.compliance.decision, 'allow');
  assert.ok(answer.source);

  const extraction = service.assistant(demoActors.broker, '陈先生35岁不吸烟，年缴1万美元，5年缴', null);
  assert.equal(extraction.kind, 'extraction');
  assert.equal(extraction.compliance.decision, 'allow');
  assert.equal(extraction.extraction.params.age, 35);
  store.close();
});
