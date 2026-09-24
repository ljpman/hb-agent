import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  const result = ctx.service.extract('陈先生35岁不吸烟，年缴1万美元，5年缴', demoActors.broker);
  assert.equal(result.params.age, 35);
  assert.equal(result.params.smoker, false);
  assert.equal(result.params.currency, 'USD');
  assert.equal(result.params.annualPremium, '10000.00');
  assert.equal(result.params.paymentTerm, '5');
  assert.deepEqual(result.missing, ['gender']);
  assert.match(result.warning, /未调用 Dify/);
  ctx.store.close();
});

test('确认快照：过期、篡改版本／hash 和未确认均不创建任务', () => {
  const ctx = setup();
  const draft = makeDraft(ctx);
  const input = { draftId: draft.id, revision: draft.revision, paramsHash: draft.paramsHash, confirmed: true };
  for (const [patch, code] of [[{ revision: 2 }, 'CONFIRMATION_CHANGED'], [{ paramsHash: 'modified' }, 'CONFIRMATION_CHANGED'], [{ confirmed: false }, 'CONFIRMATION_REQUIRED']]) {
    assert.throws(() => ctx.service.createJob(demoActors.broker, { ...input, ...patch }, 'confirm-invalid'), e => e.code === code);
  }
  ctx.advance(30 * 60000);
  assert.throws(() => makeJob(ctx, draft), e => e.code === 'CONFIRMATION_EXPIRED');
  assert.equal(ctx.store.list('job').length, 0);
  assert.equal(ctx.store.db.prepare('SELECT count(*) AS n FROM idempotency').get().n, 0);
  ctx.store.close();
});

test('同一确认快照使用不同幂等键仍只产生一个任务', () => {
  const ctx = setup();
  const draft = makeDraft(ctx);
  const a = makeJob(ctx, draft, 'first-submit');
  const b = makeJob(ctx, draft, 'second-submit');
  assert.equal(a.id, b.id);
  assert.equal(ctx.store.list('job').length, 1);
  assert.equal(ctx.store.list('event').length, 1);
  ctx.store.close();
});

test('执行结果不能覆盖授权／快照，不能跳过核验或令终态倒退', () => {
  for (const outcome of [
    { kind: 'transition', status: 'running', patch: { ownerId: 'other' } },
    { kind: 'transition', status: 'running', patch: { isMock: true, paramsHash: 'changed' } },
    { kind: 'transition', status: 'succeeded' },
    { kind: 'transition', status: 'queued' },
    { kind: 'artifact', bytes: Buffer.from('%PDF-1.4') },
    { kind: 'unexpected', status: 'running' },
  ]) {
    const ctx = setup(); const job = makeJob(ctx, makeDraft(ctx));
    ctx.service.applyOutcome(job, outcome);
    const stored = ctx.store.get('job', job.id);
    assert.equal(stored.status, 'awaiting_manual');
    assert.equal(stored.ownerId, demoActors.broker.id);
    assert.equal(stored.paramsHash, job.paramsHash);
    assert.equal(ctx.store.readArtifact(job.id), null);
    assert.throws(() => ctx.service.applyOutcome(stored, { kind: 'transition', status: 'running' }), e => e.code === 'STATE_CONFLICT');
    ctx.store.close();
  }
});

test('真实文件不能由 adapter 自行批准；模拟文件也必须通过基础格式检查', () => {
  for (const [isMock, bytes] of [[false, Buffer.from('%PDF-1.4')], [true, Buffer.from('<html>login</html>')]]) {
    const ctx = setup(); const job = makeJob(ctx, makeDraft(ctx));
    job.isMock = isMock; job.status = 'validating'; ctx.store.put('job', job);
    ctx.service.applyOutcome(job, { kind: 'artifact', bytes, text: 'claimed success' });
    assert.equal(ctx.store.get('job', job.id).status, 'awaiting_manual');
    assert.equal(ctx.store.readArtifact(job.id), null);
    assert.throws(() => ctx.service.readPdf(demoActors.broker, job.id), e => e.code === 'NOT_READY');
    if (!isMock) assert.equal(ctx.store.list('event')[0].actorName, '计划书执行服务');
    ctx.store.close();
  }
});

test('审计写入失败时状态、候选元数据及文件一起回滚；内存对象保持原样', async () => {
  for (const artifact of [false, true]) {
    const ctx = setup(); const job = makeJob(ctx, makeDraft(ctx));
    job.status = artifact ? 'validating' : 'running'; ctx.store.put('job', job);
    const before = structuredClone(job); const count = ctx.store.list('event').length;
    const put = ctx.store.put.bind(ctx.store);
    ctx.store.put = (kind, value) => { if (kind === 'event') throw new Error('disk fault'); return put(kind, value); };
    const outcome = artifact ? { kind: 'artifact', bytes: Buffer.from('%PDF-1.4'), text: 'test' }
      : { kind: 'transition', status: 'validating', text: 'test', patch: { artifactRef: 'candidate-1' } };
    assert.throws(() => ctx.service.applyOutcome(job, outcome), /disk fault/);
    assert.deepEqual(ctx.store.get('job', job.id), before);
    assert.deepEqual(job, before);
    assert.equal(ctx.store.list('event').length, count);
    assert.equal(ctx.store.readArtifact(job.id), null);
    ctx.store.put = put;
    ctx.service.applyOutcome(job, outcome);
    assert.equal(job.status, artifact ? 'succeeded' : 'validating');
    ctx.store.close();
  }
});

test('磁盘重启：保留幂等记录，继续模拟任务，真实执行中／核验中任务转人工', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-recovery-')); let store;
  try {
    const file = join(dir, 'test.sqlite'); store = new Store(file);
    const options = { stepMs: 0, pdf: async () => Buffer.from('%PDF-1.4\nmock') };
    let service = new Service(store, options); const ctx = { service, store };
    const draft = makeDraft(ctx); const mock = makeJob(ctx, draft);
    await service.tick();
    for (const status of ['running', 'validating']) store.put('job', { ...mock, id: `real-${status}`, isMock: false, execution: { mode: 'python' }, status });
    store.close(); store = new Store(file); service = new Service(store, options);
    assert.equal(makeJob({ service, store }, draft).id, mock.id);
    for (const status of ['running', 'validating']) {
      assert.equal(store.get('job', `real-${status}`).status, 'awaiting_manual');
      assert.equal(store.get('job', `real-${status}`).error, 'RESULT_UNKNOWN');
    }
    await service.tick(); await service.tick();
    assert.equal(store.get('job', mock.id).status, 'succeeded');
    assert.match(service.readPdf(demoActors.broker, mock.id).toString(), /^%PDF-/);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('下载前核对保存的 hash，存储损坏或串文件时拒绝返回内容', async () => {
  const ctx = setup();
  try {
    const job = await complete(ctx, makeJob(ctx, makeDraft(ctx)));
    const original = ctx.service.readPdf(demoActors.broker, job.id);
    for (const bytes of [Buffer.from('%PDF-1.4\nwrong job'), Buffer.from('<html>login</html>')]) {
      ctx.store.artifact(job.id, bytes);
      assert.throws(() => ctx.service.readPdf(demoActors.broker, job.id), e => e.code === 'FILE_INTEGRITY');
    }
    ctx.store.artifact(job.id, original);
    assert.deepEqual(ctx.service.readPdf(demoActors.broker, job.id), original);
  } finally { ctx.store.close(); }
});

test('完整产品快照绑定版本、字段和执行方式，任何目录漂移都需重新确认', () => {
  const mutations = [
    () => { product.version = 'DEMO-NEW'; },
    () => { product.schemaVersion = '2'; },
    () => { product.fields[0].max = 60; },
    () => { product.fields[1].options = ['女']; },
    () => { product.execution.mode = 'python'; },
    () => { product.insurerId = 'other-insurer'; },
  ];
  for (const mutate of mutations) {
    const original = structuredClone(product); const ctx = setup();
    try {
      const draft = makeDraft(ctx); mutate();
      assert.throws(() => makeJob(ctx, draft), e => e.code === 'SCHEMA_CHANGED');
      assert.equal(ctx.store.list('job').length, 0);
      assert.deepEqual(ctx.store.get('draft', draft.id).productSnapshot, original);
    } finally { Object.assign(product, original); ctx.store.close(); }
  }
});

test('确认快照的持久参数、字段或 hash 被改动时不能执行', () => {
  for (const mutate of [
    d => { d.params.age = 40; },
    d => { d.productSnapshot.fields[0].max = 99; },
    d => { d.productSnapshotHash = 'changed'; },
  ]) {
    const ctx = setup();
    try {
      const draft = makeDraft(ctx); const stored = ctx.store.get('draft', draft.id); mutate(stored); ctx.store.put('draft', stored);
      assert.throws(() => makeJob(ctx, draft), e => e.code === 'CONFIRMATION_CHANGED');
      assert.equal(ctx.store.list('job').length, 0);
    } finally { ctx.store.close(); }
  }
});

test('同参数不同产品版本的确认 hash 不相同，旧版缺少快照的草稿必须重建', () => {
  const original = structuredClone(product); const ctx = setup();
  try {
    const a = makeDraft(ctx); product.version = 'DEMO-NEW'; const b = makeDraft(ctx);
    assert.notEqual(a.paramsHash, b.paramsHash);
    const legacy = ctx.store.get('draft', b.id); delete legacy.productSnapshot; delete legacy.productSnapshotHash; ctx.store.put('draft', legacy);
    assert.throws(() => makeJob(ctx, b), e => e.code === 'SCHEMA_CHANGED');
  } finally { Object.assign(product, original); ctx.store.close(); }
});

test('历史任务与讲解包保持原字段定义，目录更新不改变已接受请求的幂等重放', async () => {
  const original = structuredClone(product); const ctx = setup();
  try {
    const draft = makeDraft(ctx); const job = await complete(ctx, makeJob(ctx, draft));
    product.fields[0].label = '新的年龄标签'; product.fields.pop(); product.version = 'DEMO-NEW';
    const pack = ctx.service.package(demoActors.broker, job.id);
    assert.equal(pack.facts[0].label, original.fields[0].label);
    assert.equal(pack.facts.length, original.fields.length);
    assert.equal(pack.job.productVersion, original.version);
    assert.deepEqual(pack.job.productSnapshot, original);
    assert.equal(makeJob(ctx, draft).id, job.id);
    const read = ctx.store.get('job', job.id); read.productSnapshot.fields[0].label = 'local mutation';
    assert.equal(ctx.store.get('job', job.id).productSnapshot.fields[0].label, original.fields[0].label);
  } finally { Object.assign(product, original); ctx.store.close(); }
});

test('表单金额按当前 schema 的最小／最大值校验，不使用旧的硬编码范围', () => {
  const original = structuredClone(product); const ctx = setup();
  try {
    const field = product.fields.find(f => f.key === 'annualPremium'); field.min = '5000.50'; field.max = '9000.25';
    for (const annualPremium of ['5000.49', '9000.26']) assert.throws(() => ctx.service.validate(validParams({ annualPremium })), e => e.code === 'PARAM_INVALID');
    for (const annualPremium of ['5000.50', '9000.25']) assert.equal(ctx.service.validate(validParams({ annualPremium })).annualPremium, annualPremium);
  } finally { Object.assign(product, original); ctx.store.close(); }
});
