import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Service } from '../server/service.mjs';
import { Store } from '../server/store.mjs';
import { demoActors, product } from '../server/catalog.mjs';
import { createAdapterRegistry } from '../server/adapters/registry.mjs';
import { createApp } from '../server/index.mjs';
import { renderProductControl } from '../public/product-control.mjs';

const options = { stepMs: 0, pdf: async () => Buffer.from('%PDF-demo') };
function draft(service) { return service.createDraft(demoActors.broker, { clientId: 'client-chen', productId: product.id, schemaVersion: product.schemaVersion,
  params: { age: 35, gender: '男', smoker: false, currency: 'USD', annualPremium: '10000', paymentTerm: '5' } }); }
function submit(service, d, key = 'product-test-key') { return service.createJob(demoActors.broker, { draftId: d.id, revision: d.revision, paramsHash: d.paramsHash, confirmed: true }, key); }
function control(service, paused) { return service.setProductAvailability(demoActors.operator, product.id, {
  paused, revision: service.productAvailability(demoActors.operator).revision, reason: paused ? '检查门户变化' : '已完成检查，恢复演示' }); }

test('产品暂停阻止新建与旧确认提交，但幂等重放仍返回已有任务；恢复不自动重跑', async () => {
  const store = new Store(); const service = new Service(store, options);
  try {
    const d = draft(service); const job = submit(service, d); const pendingDraft = draft(service);
    control(service, true);
    assert.throws(() => draft(service), e => e.code === 'PRODUCT_PAUSED');
    assert.throws(() => submit(service, pendingDraft, 'other-submit'), e => e.code === 'PRODUCT_PAUSED');
    assert.equal(submit(service, d).id, job.id);
    await service.tick();
    assert.equal(store.get('job', job.id).status, 'awaiting_manual');
    assert.equal(store.get('job', job.id).error, 'PRODUCT_PAUSED');
    assert.equal(store.readArtifact(job.id), null);
    assert.throws(() => service.resolve(demoActors.operator, job.id, { action: 'retry_mock', note: '恢复演示' }), e => e.code === 'PRODUCT_PAUSED');
    control(service, false); await service.tick();
    assert.equal(store.get('job', job.id).status, 'awaiting_manual');
    service.resolve(demoActors.operator, job.id, { action: 'retry_mock', note: '检查完成，仅重试模拟任务' });
    for (let i = 0; i < 3; i++) await service.tick();
    assert.equal(store.get('job', job.id).status, 'succeeded');
  } finally { store.close(); }
});

test('产品控制仅限同租户运营、校验原因与版本，审计失败时状态回滚', () => {
  const store = new Store(); const service = new Service(store, options);
  try {
    const input = { paused: true, revision: 0, reason: '检查门户' };
    assert.throws(() => service.setProductAvailability(demoActors.broker, product.id, input), e => e.code === 'ROLE_REQUIRED');
    for (const reason of ['', 'a', 'a'.repeat(301)]) assert.throws(() => service.setProductAvailability(demoActors.operator, product.id, { ...input, reason }), e => e.code === 'CONTROL_INVALID');
    assert.throws(() => service.setProductAvailability(demoActors.operator, product.id, { ...input, reason: 'password=do-not-save' }), e => e.code === 'SENSITIVE_INPUT');
    control(service, true);
    assert.equal(service.productAvailability(demoActors.broker).paused, true);
    assert.equal(service.productAvailability(demoActors.other).paused, false);
    assert.throws(() => service.setProductAvailability(demoActors.operator, product.id, input), e => e.code === 'VERSION_CONFLICT');
    const put = store.put.bind(store);
    store.put = (kind, value) => { if (kind === 'event') throw new Error('audit fault'); return put(kind, value); };
    assert.throws(() => control(service, false), /audit fault/);
    assert.equal(service.productAvailability(demoActors.operator).paused, true);
    assert.equal(service.productAvailability(demoActors.operator).revision, 1);
  } finally { store.close(); }
});

test('运营处理说明与状态原子提交，记录失败不会丢失人工任务', async () => {
  const store = new Store(); const service = new Service(store, options);
  try {
    const job = submit(service, draft(service)); control(service, true); await service.tick();
    const put = store.put.bind(store);
    store.put = (kind, value) => { if (kind === 'event' && value.type === 'operator.resolved') throw new Error('audit fault'); return put(kind, value); };
    assert.throws(() => service.resolve(demoActors.operator, job.id, { action: 'close', note: '人工关闭' }), /audit fault/);
    assert.equal(store.get('job', job.id).status, 'awaiting_manual');
    assert.equal(store.list('event').some(e => e.type === 'proposal.failed'), false);
  } finally { store.close(); }
});

test('门户变化自动暂停当前租户产品，其他排队任务转人工；在途任务不因手动暂停被重提', async () => {
  const store = new Store();
  const registry = { ...createAdapterRegistry(), resolve: () => ({ isMock: true, async advance() {
    return { kind: 'transition', status: 'awaiting_manual', error: 'PORTAL_CHANGED', text: '门户变化' };
  } }) };
  const service = new Service(store, { ...options, registry });
  try {
    const first = submit(service, draft(service)); const second = submit(service, draft(service), 'second-job');
    await service.tick(); assert.equal(service.productAvailability(demoActors.broker).paused, true);
    assert.equal(service.productAvailability(demoActors.other).paused, false);
    await service.tick(); assert.equal(store.get('job', second.id).error, 'PRODUCT_PAUSED');
    assert.equal(store.get('job', first.id).error, 'PORTAL_CHANGED');
  } finally { store.close(); }
});

test('排队任务领取后发生暂停，提交结果时再次检查，不能进入 running', async () => {
  const store = new Store(); let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const registry = { ...createAdapterRegistry(), resolve: () => ({ isMock: true, async advance() {
    enter(); await new Promise(resolve => { release = resolve; });
    return { kind: 'transition', status: 'running', text: 'start' };
  } }) };
  const service = new Service(store, { ...options, registry });
  try {
    const job = submit(service, draft(service)); const running = service.tick(); await entered;
    control(service, true); release(); await running;
    assert.equal(store.get('job', job.id).error, 'PRODUCT_PAUSED');
    assert.equal(store.get('job', job.id).status, 'awaiting_manual');
  } finally { store.close(); }
});

test('产品暂停在磁盘重启后保留，已在运行的模拟任务继续完成', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hb-product-')); let store;
  try {
    const path = join(directory, 'test.sqlite'); store = new Store(path); let service = new Service(store, options);
    const job = submit(service, draft(service)); await service.tick(); control(service, true);
    store.close(); store = new Store(path); service = new Service(store, options);
    assert.equal(service.productAvailability(demoActors.broker).paused, true);
    await service.tick(); await service.tick();
    assert.equal(store.get('job', job.id).status, 'succeeded');
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('产品控制视图仅向运营提供操作，所有原因转义', () => {
  const state = { paused: true, revision: 1, reason: '<img src=x onerror=alert(1)>' };
  const broker = renderProductControl(demoActors.broker, product, state);
  assert.match(broker, /已暂停新任务/); assert.doesNotMatch(broker, /<form|<img/);
  const operator = renderProductControl(demoActors.operator, product, state);
  assert.match(operator, /恢复新任务/); assert.match(operator, /product-control-form/); assert.doesNotMatch(operator, /<img/);
});

test('产品控制 HTTP 同源、角色和租户隔离，bootstrap 展示持久状态', async () => {
  const app = createApp({ database: ':memory:', tick: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const login = async actor => (await fetch(origin + '/api/demo/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ actor }) })).headers.get('set-cookie').split(';')[0];
  try {
    const operator = await login('operator'); const broker = await login('broker'); const other = await login('other');
    const url = origin + `/api/products/${product.id}/availability`;
    const patch = (cookie, withOrigin = true) => fetch(url, { method: 'PATCH', headers: { cookie, ...(withOrigin ? { origin } : {}), 'content-type': 'application/json' }, body: JSON.stringify({ revision: 0, paused: true, reason: '测试暂停', tenantId: 'other-agency' }) });
    assert.equal((await patch(operator, false)).status, 403);
    assert.equal((await patch(broker)).status, 403);
    assert.equal((await patch(operator)).status, 200);
    assert.equal((await (await fetch(url, { headers: { cookie: other } })).json()).paused, false);
    const bootstrap = await (await fetch(origin + '/api/bootstrap', { headers: { cookie: broker } })).json();
    assert.equal(bootstrap.productAvailability.paused, true);
    assert.equal((await fetch(origin + '/product-control.mjs')).status, 200);
  } finally { await app.close(); }
});
