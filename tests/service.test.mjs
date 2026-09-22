import assert from 'node:assert/strict';
import test from 'node:test';

import { demoActors, product } from '../server/catalog.mjs';
import { AppError } from '../server/errors.mjs';
import { Service } from '../server/service.mjs';
import { Store } from '../server/store.mjs';

function setup() {
  let clock = Date.parse('2026-09-22T01:00:00.000Z');
  const store = new Store(':memory:');
  const service = new Service(store, {
    now: () => clock,
    stepMs: 0,
    pdf: async job => Buffer.from(`%PDF-1.4\n${job.id}`),
  });
  return { service, store, advance(ms = 1) { clock += ms; } };
}

function validParams(overrides = {}) {
  return { age: 35, gender: '男', smoker: false, currency: 'USD', annualPremium: 10_000, paymentTerm: '5', ...overrides };
}

function makeDraft(ctx, scenario = 'success') {
  return ctx.service.createDraft(demoActors.broker, {
    clientId: 'client-chen', productId: product.id, schemaVersion: product.schemaVersion,
    params: validParams(), scenario,
  });
}

function makeJob(ctx, draft, key = 'idem-key-001') {
  return ctx.service.createJob(demoActors.broker, {
    draftId: draft.id, revision: draft.revision, paramsHash: draft.paramsHash, confirmed: true,
  }, key);
}

async function complete(ctx, job) {
  for (let index = 0; index < 3; index += 1) { ctx.advance(); await ctx.service.tick(); }
  return ctx.service.get(demoActors.broker, 'job', job.id);
}

test('参数校验保留 false，并规范化金额', () => {
  const ctx = setup();
  const checked = ctx.service.validate(validParams({ smoker: false, annualPremium: '10000.50' }));
  assert.equal(checked.smoker, false);
  assert.equal(checked.annualPremium, '10000.50');
  ctx.store.close();
});

test('幂等键返回同一任务，并拒绝同键不同请求', () => {
  const ctx = setup();
  const draft = makeDraft(ctx);
  const first = makeJob(ctx, draft);
  const replay = makeJob(ctx, draft);
  assert.equal(first.id, replay.id);
  assert.throws(
    () => ctx.service.createJob(demoActors.broker, { draftId: draft.id, revision: 99, paramsHash: draft.paramsHash, confirmed: true }, 'idem-key-001'),
    error => error instanceof AppError && error.status === 409,
  );
  ctx.store.close();
});

test('经纪只能读取自己名下的客户', () => {
  const ctx = setup();
  assert.equal(ctx.service.get(demoActors.broker, 'client', 'client-chen').name, '陈先生');
  assert.throws(() => ctx.service.get(demoActors.colleague, 'client', 'client-chen'), error => error instanceof AppError && error.status === 404);
  assert.throws(() => ctx.service.get(demoActors.other, 'client', 'client-chen'), error => error instanceof AppError && error.status === 404);
  ctx.store.close();
});

test('异步任务成功后生成 PDF，并能形成可审核讲解包', async () => {
  const ctx = setup();
  const job = await complete(ctx, makeJob(ctx, makeDraft(ctx)));
  assert.equal(job.status, 'succeeded');
  assert.match(job.artifactHash, /^[a-f0-9]{64}$/);
  assert.match(ctx.service.readPdf(demoActors.broker, job.id).toString(), /^%PDF-/);

  const pack = ctx.service.package(demoActors.broker, job.id);
  assert.equal(pack.status, 'draft');
  const saved = ctx.service.savePackage(demoActors.broker, job.id, { revision: pack.revision, note: '已由经纪核对的摘要' });
  const reviewed = ctx.service.savePackage(demoActors.broker, job.id, { revision: saved.revision, confirmed: true }, true);
  assert.equal(reviewed.status, 'reviewed');
  ctx.store.close();
});

test('人工接管、失败和文件不一致均进入明确终态', async () => {
  for (const [scenario, expected] of [['manual', 'awaiting_manual'], ['failed', 'failed'], ['mismatch', 'awaiting_manual']]) {
    const ctx = setup();
    const job = await complete(ctx, makeJob(ctx, makeDraft(ctx, scenario), `idem-${scenario}-001`));
    assert.equal(job.status, expected);
    if (scenario === 'mismatch') assert.equal(job.error, 'PDF_MISMATCH');
    ctx.store.close();
  }
});

test('客户跟进采用乐观锁，防止两人覆盖更新', () => {
  const ctx = setup();
  const client = ctx.service.get(demoActors.broker, 'client', 'client-chen');
  const updated = ctx.service.updateClient(demoActors.broker, client.id, {
    revision: client.revision, stage: '方案讲解', nextAt: '2026-09-29', nextAction: '确认缴费年期', notes: '内部备注',
  });
  assert.equal(updated.revision, client.revision + 1);
  assert.throws(
    () => ctx.service.updateClient(demoActors.broker, client.id, { revision: client.revision, stage: '暂缓跟进', nextAt: '2026-10-01', nextAction: '旧页面覆盖', notes: '' }),
    error => error instanceof AppError && error.status === 409,
  );
  ctx.store.close();
});

test('本地提取器只抽参数，缺失字段和限制会明确返回', () => {
  const ctx = setup();
  const result = ctx.service.extract('陈先生35岁不吸烟，年缴1万美元，5年缴');
  assert.equal(result.params.age, 35);
  assert.equal(result.params.smoker, false);
  assert.equal(result.params.currency, 'USD');
  assert.equal(result.params.annualPremium, '10000.00');
  assert.equal(result.params.paymentTerm, '5');
  assert.deepEqual(result.missing, ['gender']);
  assert.match(result.warning, /未调用 Dify/);
  ctx.store.close();
});

