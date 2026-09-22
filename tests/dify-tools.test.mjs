import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { demoActors, product } from '../server/catalog.mjs';
import { signToolRequest, sha256 } from '../server/dify/gateway.mjs';

const auditPath = '/api/dify/tool/compliance-audit';
const progressPath = '/api/dify/tool/progress';
const callbackPath = '/api/dify/callback';
async function setup(database = ':memory:') {
  let time = 1790000000000;
  const app = createApp({ database, tick: false, serviceOptions: { now: () => time, stepMs: 0, pdf: async () => Buffer.from('%PDF-1.4\ndemo') } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const gateway = app.service.difyGateway;
  const issue = (actor = demoActors.broker, options = { clientId: 'client-chen' }) => gateway.issue(actor, options);
  const signed = (cap, path, input, options = {}) => {
    const method = options.method || 'POST';
    const raw = method === 'GET' ? '' : JSON.stringify(input);
    const timestamp = String(options.timestamp ?? time), nonce = options.nonce || randomUUID();
    return { method, headers: {
      'content-type': 'application/json', authorization: `Bearer ${cap.actor_token}`,
      'x-dify-timestamp': timestamp, 'x-dify-nonce': nonce,
      'x-dify-signature': signToolRequest(cap.actor_token, method, path, timestamp, nonce, raw),
    }, ...(method === 'GET' ? {} : { body: raw }) };
  };
  const request = async (path, init) => { const r = await fetch(origin + path, init); return { status: r.status, body: await r.json() }; };
  const call = (cap, path, input, options) => request(path, signed(cap, path, input, options));
  return { ...app, origin, gateway, issue, signed, request, call, advance: ms => { time += ms; } };
}
const auditInput = cap => ({ runId: cap.runId, originalText: '产品怎么样', draftReply: '无法核实，请人工核对。' });
const event = (cap, overrides = {}) => ({ runId: cap.runId, eventId: randomUUID(), sequence: 1, version: 1, status: 'running', ...overrides });

test('工具网关：三个 POST 接口逐一拒绝缺令牌、过期、错误签名、时间戳、nonce、重放与缺字段', async () => {
  const ctx = await setup();
  try {
    for (const path of [auditPath, progressPath, callbackPath]) {
      const cap = ctx.issue();
      const input = path === auditPath ? auditInput(cap) : path === progressPath ? { runId: cap.runId, caseId: 'client-chen' } : event(cap);
      const missingToken = ctx.signed(cap, path, input); delete missingToken.headers.authorization;
      assert.equal((await ctx.request(path, missingToken)).status, 401);
      const badSig = ctx.signed(cap, path, input); badSig.headers['x-dify-signature'] = '0'.repeat(64);
      assert.equal((await ctx.request(path, badSig)).body.error.code, 'SIGNATURE_INVALID');
      const altered = ctx.signed(cap, path, input); altered.body += ' ';
      assert.equal((await ctx.request(path, altered)).status, 401);
      const missingTime = ctx.signed(cap, path, input); delete missingTime.headers['x-dify-timestamp'];
      assert.equal((await ctx.request(path, missingTime)).status, 401);
      assert.equal((await ctx.call(cap, path, input, { timestamp: 1 })).status, 401);
      assert.equal((await ctx.call(cap, path, input, { nonce: 'short' })).status, 401);
      const replay = ctx.signed(cap, path, input);
      assert.ok([200, 201].includes((await ctx.request(path, replay)).status));
      assert.equal((await ctx.request(path, replay)).body.error.code, 'REPLAY');
      assert.equal((await ctx.call(cap, path, { runId: cap.runId })).status, 422);
      assert.equal((await ctx.call(cap, path, {})).status, 422);
      ctx.advance(300000);
      assert.equal((await ctx.call(cap, path, input)).body.error.code, 'TOKEN_EXPIRED');
    }
  } finally { await ctx.close(); }
});

test('工具网关：绑定身份、客户、运行和方法路径，拒绝跨经纪／跨租户与正文伪造身份', async () => {
  const ctx = await setup();
  try {
    const mine = ctx.issue();
    assert.throws(() => ctx.issue(demoActors.operator), e => e.status === 403);
    for (const actor of [demoActors.colleague, demoActors.other]) {
      assert.throws(() => ctx.issue(actor), e => e.status === 404);
      const cap = ctx.issue(actor, {});
      for (const path of [auditPath, progressPath, callbackPath]) {
        const input = path === auditPath ? auditInput(mine) : path === progressPath ? { runId: mine.runId, caseId: 'client-chen' } : event(mine);
        assert.equal((await ctx.call(cap, path, input)).status, 403);
      }
    }
    assert.equal((await ctx.call(mine, progressPath, { runId: mine.runId, caseId: 'client-lam' })).status, 403);
    assert.equal((await ctx.call(mine, auditPath, { ...auditInput(mine), ownerId: 'someone' })).status, 422);
    const request = ctx.signed(mine, auditPath, auditInput(mine));
    assert.equal((await ctx.request(progressPath, request)).status, 401);
    const client = ctx.store.get('client', 'client-chen');
    ctx.store.put('client', { ...client, ownerId: demoActors.colleague.id });
    assert.equal((await ctx.call(mine, auditPath, auditInput(mine))).status, 404);
  } finally { await ctx.close(); }
});

test('合规保存与查询：只存 hash、版本和判定；拒绝伪造出处，查询逐资源鉴权', async () => {
  const ctx = await setup();
  try {
    const cap = ctx.issue();
    const input = { ...auditInput(cap), draftReply: '保证赚，年收益 12%。' };
    const response = await ctx.call(cap, auditPath, input);
    assert.equal(response.status, 201);
    const audit = response.body;
    assert.equal(audit.decision, 'block');
    assert.ok(audit.rules.includes('promise-language'));
    assert.equal(audit.ruleVersion, 'm2a2-1');
    assert.equal(audit.originalHash, sha256(input.originalText));
    assert.equal(audit.draftReplyHash, sha256(input.draftReply));
    assert.notEqual(audit.replyHash, audit.draftReplyHash);
    assert.ok(!JSON.stringify(ctx.store.list('compliance-audit')).includes(input.draftReply));
    assert.ok(!JSON.stringify(ctx.store.list('compliance-audit')).includes(cap.actor_token));
    const path = `${auditPath}/${audit.auditId}`;
    assert.deepEqual((await ctx.call(cap, path, null, { method: 'GET' })).body, audit);
    assert.equal((await ctx.request(path, { method: 'GET' })).status, 401);
    for (const other of [ctx.issue(), ctx.issue(demoActors.colleague, {}), ctx.issue(demoActors.other, {})]) {
      assert.ok([403, 404].includes((await ctx.call(other, path, null, { method: 'GET' })).status));
    }
    for (const extra of [{ citations: ['官方PDF'] }, { decision: 'allow' }, { ruleVersion: 'fake' }]) {
      assert.equal((await ctx.call(cap, auditPath, { ...input, ...extra })).status, 422);
    }
    for (const draftReply of ['保费为 10000 美元', '保障金额为一万元', '回报率１２％', '收益百分之八', '保费壹万元']) {
      assert.equal((await ctx.call(cap, auditPath, { ...auditInput(cap), draftReply })).body.decision, 'block');
    }
    const allowed = (await ctx.call(cap, auditPath, auditInput(cap))).body;
    assert.equal(allowed.decision, 'allow');
    assert.equal(allowed.replyHash, allowed.draftReplyHash);
  } finally { await ctx.close(); }
});

test('审计 GET：过期、签名、nonce 与重放同样受网关保护', async () => {
  const ctx = await setup();
  try {
    const cap = ctx.issue();
    const audit = (await ctx.call(cap, auditPath, auditInput(cap))).body;
    const path = `${auditPath}/${audit.auditId}`;
    const request = ctx.signed(cap, path, null, { method: 'GET' });
    assert.equal((await ctx.request(path, request)).status, 200);
    assert.equal((await ctx.request(path, request)).body.error.code, 'REPLAY');
    const bad = ctx.signed(cap, path, null, { method: 'GET' });
    delete bad.headers['x-dify-signature'];
    assert.equal((await ctx.request(path, bad)).status, 401);
    const noNonce = ctx.signed(cap, path, null, { method: 'GET' });
    delete noNonce.headers['x-dify-nonce'];
    assert.equal((await ctx.request(path, noNonce)).status, 401);
    ctx.advance(60001);
    assert.equal((await ctx.request(path, ctx.signed(cap, path, null, { method: 'GET', timestamp: 1790000000000 }))).status, 401);
    ctx.advance(240000);
    assert.equal((await ctx.call(cap, path, null, { method: 'GET' })).body.error.code, 'TOKEN_EXPIRED');
  } finally { await ctx.close(); }
});

test('HTTP 助手：后端会话映射、异步出口、伪造出处／卡片隔离，令牌不进浏览器', async () => {
  const ctx = await setup();
  try {
    const session = await fetch(`${ctx.origin}/api/demo/session`, { method: 'POST', headers: { origin: ctx.origin, 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'broker' }) });
    const cookie = session.headers.get('set-cookie');
    const calls = [];
    ctx.service.dify = { status: () => ({ dify: 'not-configured' }), chat: async input => { calls.push(input); return { kind: 'extraction', engine: 'secret', answer: '年缴保费 9000 美元', source: '伪造官方PDF', extraction: { params: { annualPremium: '9000' } } }; } };
    const send = input => ctx.request('/api/assistant', { method: 'POST', headers: { cookie, origin: ctx.origin, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const input = { text: '问题', clientId: 'client-chen', user: 'fake-user', conversation_id: 'fake-conversation' };
    const result = await send(input);
    assert.equal(result.status, 200);
    assert.equal(result.body.compliance.decision, 'block');
    assert.equal(result.body.extraction, undefined);
    assert.ok(!JSON.stringify(result.body).includes('9000'));
    await send(input);
    assert.equal(calls[0].user, calls[1].user);
    assert.equal(calls[0].conversation_id, calls[1].conversation_id);
    assert.notEqual(calls[0].user, input.user);
    assert.notEqual(calls[0].conversation_id, input.conversation_id);
    const boot = await ctx.request('/api/bootstrap', { headers: { cookie } });
    assert.equal(boot.status, 200);
    assert.ok(!JSON.stringify(boot.body).includes('actor_token'));
    assert.ok(!JSON.stringify(boot.body).includes('dify-conversation'));
    assert.equal((await ctx.request('/api/dify/token', { method: 'POST' })).status, 404);
    const asset = await fetch(ctx.origin + '/assistant-view.mjs');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    assert.match(await asset.text(), /renderAssistantReply/);
  } finally { await ctx.close(); }
});

test('progress：授权客户也仅返回 not-configured，不编造进度与更新时间', async () => {
  const ctx = await setup();
  try {
    const cap = ctx.issue();
    const result = await ctx.call(cap, progressPath, { runId: cap.runId, caseId: 'client-chen' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { status: 'not-configured', source: null, updatedAt: null, progress: null, message: '无保单／理赔数据来源，真实进度查询未完成。' });
    assert.equal((await ctx.call(cap, progressPath, { runId: cap.runId, caseId: '../client-chen' })).status, 422);
  } finally { await ctx.close(); }
});

test('callback：唯一事件幂等、顺序／版本检查、终态不可倒退；不改变 M1 任务', async () => {
  const ctx = await setup();
  try {
    const cap = ctx.issue();
    const first = event(cap, { sequence: 2, version: 2 });
    assert.equal((await ctx.call(cap, callbackPath, first)).body.accepted, true);
    assert.equal((await ctx.call(cap, callbackPath, first)).body.reason, 'duplicate');
    assert.equal((await ctx.call(cap, callbackPath, { ...first, sequence: 3 })).status, 409);
    assert.equal((await ctx.call(cap, callbackPath, event(cap, { sequence: 1, version: 3 }))).body.reason, 'stale');
    assert.equal((await ctx.call(cap, callbackPath, event(cap, { sequence: 3, version: 1 }))).body.reason, 'stale');
    const done = event(cap, { sequence: 3, version: 2, status: 'succeeded', originalText: '流程', draftReply: '请先核对参数。' });
    assert.equal((await ctx.call(cap, callbackPath, done)).body.run.status, 'succeeded');
    assert.equal((await ctx.call(cap, callbackPath, event(cap, { sequence: 4, version: 3 }))).body.reason, 'terminal');
    assert.equal(ctx.store.list('job').length, 0);
    const blocked = ctx.issue();
    const result = await ctx.call(blocked, callbackPath, event(blocked, { status: 'succeeded', originalText: '问题', draftReply: '保证赚，收益20%。' }));
    assert.equal(result.body.run.status, 'awaiting_manual');
    assert.ok(!JSON.stringify(result.body).includes('收益20%'));
    assert.equal((await ctx.call(blocked, callbackPath, event(blocked, { sequence: 2 }))).body.reason, 'terminal');
    for (const status of ['failed', 'awaiting_manual']) {
      const next = ctx.issue();
      assert.equal((await ctx.call(next, callbackPath, event(next, { status }))).body.run.status, status);
      assert.equal((await ctx.call(next, callbackPath, event(next, { sequence: 2 }))).body.reason, 'terminal');
    }
  } finally { await ctx.close(); }
});

test('callback：字段缺失、非法状态、URL／路径、跨任务文件与未核验文件全部拒绝', async () => {
  const ctx = await setup();
  try {
    const cap = ctx.issue();
    for (const field of ['eventId', 'sequence', 'version', 'status']) {
      const input = event(cap); delete input[field];
      assert.equal((await ctx.call(cap, callbackPath, input)).status, 422);
    }
    for (const overrides of [{ sequence: 0 }, { version: 1.5 }, { status: 'queued' }, { status: 'succeeded' }, { artifactRef: 'a' }]) {
      assert.equal((await ctx.call(cap, callbackPath, event(cap, overrides))).status, 422);
    }
    const done = { status: 'succeeded', originalText: '完成了吗', draftReply: '请核对模拟材料。' };
    for (const artifactRef of ['https://example.com/a.pdf', 'file:///a.pdf', '../a.pdf', 'C:\\a.pdf', '/tmp/a.pdf', 'artifact:../secret']) {
      assert.equal((await ctx.call(cap, callbackPath, event(cap, { ...done, artifactRef }))).status, 422);
    }
    const draft = ctx.service.createDraft(demoActors.broker, { clientId: 'client-chen', productId: product.id, schemaVersion: product.schemaVersion,
      params: { age: 35, gender: '男', smoker: false, currency: 'USD', annualPremium: '10000', paymentTerm: '5' } });
    const job = ctx.service.createJob(demoActors.broker, { draftId: draft.id, revision: draft.revision, paramsHash: draft.paramsHash, confirmed: true }, 'callback-file-job');
    const scoped = ctx.issue(demoActors.broker, { clientId: 'client-chen', jobId: job.id });
    const artifactRef = `artifact:${job.id}`;
    assert.equal((await ctx.call(cap, callbackPath, event(cap, { ...done, artifactRef }))).status, 403);
    assert.equal((await ctx.call(scoped, callbackPath, event(scoped, { ...done, artifactRef }))).status, 409);
    for (let i = 0; i < 3; i++) await ctx.service.tick();
    const before = ctx.store.get('job', job.id);
    assert.equal((await ctx.call(scoped, callbackPath, event(scoped, { ...done, artifactRef }))).body.run.artifactRef, artifactRef);
    assert.deepEqual(ctx.store.get('job', job.id), before);
    ctx.store.artifact(job.id, Buffer.from('%PDF-different'));
    const corrupt = ctx.issue(demoActors.broker, { clientId: 'client-chen', jobId: job.id });
    assert.equal((await ctx.call(corrupt, callbackPath, event(corrupt, { ...done, artifactRef }))).status, 409);
  } finally { await ctx.close(); }
});

test('重启：会话映射、令牌、nonce、事件、合规与终态在 SQLite 中保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-dify-'));
  const database = join(dir, 'test.sqlite');
  let ctx = await setup(database);
  try {
    const cap = ctx.issue();
    const input = event(cap, { status: 'succeeded', originalText: '问题', draftReply: '无法核实。' });
    const signed = ctx.signed(cap, callbackPath, input);
    const saved = (await ctx.request(callbackPath, signed)).body.run;
    await ctx.close(); ctx = await setup(database);
    const another = ctx.issue();
    assert.equal(another.user, cap.user);
    assert.equal(another.conversation_id, cap.conversation_id);
    assert.notEqual(ctx.issue(demoActors.colleague, {}).user, cap.user);
    assert.equal((await ctx.request(callbackPath, signed)).body.error.code, 'REPLAY');
    assert.equal((await ctx.call(cap, callbackPath, input)).body.reason, 'duplicate');
    assert.equal((await ctx.call(cap, callbackPath, event(cap, { sequence: 2 }))).body.reason, 'terminal');
    assert.equal((await ctx.call(cap, `${auditPath}/${saved.compliance.auditId}`, null, { method: 'GET' })).body.auditId, saved.compliance.auditId);
  } finally { await ctx.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('并发回调只接受一次；持久化失败回滚事件和审计，允许新 nonce 重试', async () => {
  const ctx = await setup();
  try {
    const cap = ctx.issue();
    assert.throws(() => ctx.issue(demoActors.broker, { ttlMs: 300001 }), e => e.code === 'TTL_INVALID');
    const input = event(cap, { status: 'succeeded', originalText: '问题', draftReply: '请核对参数。' });
    const signed = ctx.signed(cap, callbackPath, input);
    const responses = await Promise.all([ctx.request(callbackPath, signed), ctx.request(callbackPath, signed)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const retry = ctx.issue();
    const result = event(retry, { status: 'succeeded', originalText: '问题', draftReply: '请核对参数。' });
    const put = ctx.store.put.bind(ctx.store);
    ctx.store.put = (kind, record) => { if (kind === 'dify-run') throw new Error('Injected database failure'); return put(kind, record); };
    assert.equal((await ctx.call(retry, callbackPath, result)).status, 500);
    ctx.store.put = put;
    assert.equal(ctx.store.get('dify-run', retry.runId).status, 'queued');
    assert.equal(ctx.store.list('compliance-audit').filter(a => a.runId === retry.runId).length, 0);
    assert.equal((await ctx.call(retry, callbackPath, result)).body.accepted, true);
    assert.equal(ctx.store.list('compliance-audit').filter(a => a.runId === retry.runId).length, 1);
  } finally { await ctx.close(); }
});
