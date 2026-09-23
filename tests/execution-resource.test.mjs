import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Service } from '../server/service.mjs';
import { Store } from '../server/store.mjs';
import { createAdapterRegistry } from '../server/adapters/registry.mjs';
import { demoActors, product } from '../server/catalog.mjs';

function setup(filename = ':memory:', error) {
  const calls = []; const store = new Store(filename);
  const registry = createAdapterRegistry({ pythonAdapterUrl: 'http://offline', transport: async (_, request) => {
    calls.push(request);
    if (error) return { jobId: request.jobId, attemptId: request.attemptId, isMock: false, error };
    return { jobId: request.jobId, attemptId: request.attemptId, isMock: false, status: 'validating', artifactRef: 'candidate',
      source: { insurerId: 'test-insurer', productId: request.productId, productVersion: request.productVersion } };
  } });
  const options = { stepMs: 0, registry };
  const service = new Service(store, options);
  return { store, service, calls, options };
}
function job(ctx, id, credentialRef, status = 'queued', tenantId = demoActors.broker.tenantId) {
  const now = new Date().toISOString();
  return ctx.store.put('job', { id, tenantId, ownerId: demoActors.broker.id, clientId: 'client-chen', draftId: 'test-draft',
    productId: product.id, productVersion: product.version, schemaVersion: product.schemaVersion, params: { age: 35 }, paramsHash: 'test-hash',
    credentialRef, execution: { mode: 'python' }, isMock: false, status, nextAt: 0, history: [], createdAt: now, updatedAt: now });
}
const close = (service, id, extra = {}) => service.resolve(demoActors.operator, id, { action: 'close', note: '已核对门户结果和执行会话', portalChecked: true, ...extra });

test('同一账号不同任务串行，不同账号仍可处理；候选待核验期间保留账号', async () => {
  const ctx = setup();
  try {
    job(ctx, 'first', 'account-a', 'running'); await ctx.service.tick();
    job(ctx, 'second', 'account-a'); job(ctx, 'third', 'account-b');
    await ctx.service.tick(); // first validating → manual
    await ctx.service.tick(); // second blocked, third queued → running
    await ctx.service.tick(); // third runs with its own slot
    assert.deepEqual(ctx.calls.map(r => r.jobId), ['first', 'third']);
    assert.equal(ctx.store.get('job', 'second').status, 'queued');
    assert.equal(ctx.store.db.prepare('SELECT count(*) AS n FROM execution_resources').get().n, 2);
    assert.equal(JSON.stringify(ctx.store.db.prepare('SELECT * FROM execution_resources').all()).includes('account-a'), false);
  } finally { ctx.store.close(); }
});

test('真实账号未配置时使用共同执行槽，同一账号也不能跨租户并发', async () => {
  for (const credentialRef of [undefined, 'shared-account']) {
    const ctx = setup();
    try {
      job(ctx, 'first', credentialRef, 'running'); await ctx.service.tick();
      job(ctx, 'other-tenant', credentialRef, 'queued', 'other-agency');
      await ctx.service.tick(); await ctx.service.tick();
      assert.equal(ctx.calls.length, 1);
      assert.equal(ctx.store.get('job', 'other-tenant').status, 'queued');
    } finally { ctx.store.close(); }
  }
});

test('关闭人工任务必须明确确认门户结束，越权或缺少确认不能释放账号', async () => {
  const ctx = setup();
  try {
    job(ctx, 'first', 'account', 'running'); await ctx.service.tick(); await ctx.service.tick();
    assert.throws(() => close(ctx.service, 'first', { portalChecked: false }), e => e.code === 'PORTAL_CHECK_REQUIRED');
    assert.throws(() => ctx.service.resolve(demoActors.broker, 'first', { action: 'close', note: '已核实', portalChecked: true }), e => e.code === 'ROLE_REQUIRED');
    assert.throws(() => ctx.service.resolve({ ...demoActors.operator, tenantId: 'other' }, 'first', { action: 'close', note: '已核实', portalChecked: true }), e => e.code === 'NOT_FOUND');
    job(ctx, 'second', 'account'); await ctx.service.tick(); assert.equal(ctx.calls.length, 1);
    close(ctx.service, 'first'); await ctx.service.tick(); await ctx.service.tick();
    assert.equal(ctx.store.get('job', 'first').status, 'failed');
    assert.deepEqual(ctx.calls.map(r => r.jobId), ['first', 'second']);
    assert.equal(ctx.store.list('event').filter(e => e.type === 'execution.account-released').length, 1);
  } finally { ctx.store.close(); }
});

test('运营释放账号审计失败时整个关闭操作回滚', async () => {
  const ctx = setup();
  try {
    job(ctx, 'first', 'account', 'running'); await ctx.service.tick(); await ctx.service.tick();
    const put = ctx.store.put.bind(ctx.store);
    ctx.store.put = (kind, value) => { if (kind === 'event' && value.type === 'execution.account-released') throw new Error('audit fault'); return put(kind, value); };
    assert.throws(() => close(ctx.service, 'first'), /audit fault/);
    assert.equal(ctx.store.get('job', 'first').status, 'awaiting_manual');
    assert.equal(ctx.store.db.prepare('SELECT job_id FROM execution_resources').get().job_id, 'first');
  } finally { ctx.store.close(); }
});

test('重启后未知结果仍占用账号，不能按过期时间自动解除', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hb-account-')); let store;
  try {
    const path = join(directory, 'test.sqlite'); const ctx = setup(path); store = ctx.store;
    job(ctx, 'first', 'account', 'running'); await ctx.service.tick();
    job(ctx, 'second', 'account'); store.close(); store = new Store(path);
    const service = new Service(store, ctx.options); await service.tick();
    assert.equal(store.get('job', 'first').status, 'awaiting_manual');
    assert.equal(store.get('job', 'second').status, 'queued');
    assert.equal(ctx.calls.length, 1);
    close(service, 'first'); await service.tick(); await service.tick();
    assert.equal(ctx.calls.length, 2);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('契约明确拒绝参数或产品时释放账号，未知错误继续保留', async () => {
  for (const error of ['PARAM_INVALID', 'PRODUCT_UNAVAILABLE', 'RESULT_UNKNOWN']) {
    const ctx = setup(':memory:', error);
    try {
      job(ctx, 'first', 'account', 'running'); await ctx.service.tick();
      const held = ctx.store.db.prepare('SELECT count(*) AS n FROM execution_resources').get().n;
      assert.equal(held, error === 'RESULT_UNKNOWN' ? 1 : 0);
      assert.equal(ctx.store.get('job', 'first').status, error === 'RESULT_UNKNOWN' ? 'awaiting_manual' : 'failed');
    } finally { ctx.store.close(); }
  }
});

test('即使人工状态存在，有效本地租约未结束时也不能人工释放账号', async () => {
  const ctx = setup();
  try {
    job(ctx, 'first', 'account', 'running'); await ctx.service.tick(); await ctx.service.tick();
    ctx.store.db.prepare('INSERT INTO job_leases VALUES(?,?,?,?,?)').run('first', 'test-worker', 'test-token', Date.now() + 30000, Date.now());
    assert.throws(() => close(ctx.service, 'first'), e => e.code === 'EXECUTION_ACTIVE');
    assert.equal(ctx.store.db.prepare('SELECT count(*) AS n FROM execution_resources').get().n, 1);
  } finally { ctx.store.close(); }
});
