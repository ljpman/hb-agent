import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Service } from '../server/service.mjs';
import { Store } from '../server/store.mjs';
import { demoActors, product } from '../server/catalog.mjs';
import { createAdapterRegistry } from '../server/adapters/registry.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'hb-leases-'));
  const database = join(directory, 'test.sqlite'); const stores = [];
  const connect = () => { const store = new Store(database); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { connect, database };
}
function mockJob(service, status = 'validating') {
  const draft = service.createDraft(demoActors.broker, { clientId: 'client-chen', productId: product.id, schemaVersion: product.schemaVersion,
    params: { age: 35, gender: '男', smoker: false, currency: 'USD', annualPremium: '10000', paymentTerm: '5' } });
  const job = service.createJob(demoActors.broker, { draftId: draft.id, revision: draft.revision, paramsHash: draft.paramsHash, confirmed: true }, 'lease-test-job');
  job.status = status; job.nextAt = 0; service.store.put('job', job); return job;
}
function realJob(service) {
  const job = mockJob(service, 'running'); job.isMock = false; job.execution = { mode: 'python' };
  service.store.put('job', job); return job;
}
const candidate = request => ({ jobId: request.jobId, attemptId: request.attemptId, isMock: false, status: 'validating', artifactRef: 'test-ref',
  source: { insurerId: 'test-insurer', productId: request.productId, productVersion: request.productVersion } });

test('两个 SQLite 连接争用任务时只有一个渲染，启动恢复不会抢有效租约', async t => {
  const f = fixture(t); const entered = deferred(); const release = deferred(); let calls = 0;
  const a = new Service(f.connect(), { stepMs: 0, pdf: async () => { calls++; entered.resolve(); await release.promise; return Buffer.from('%PDF-test'); } });
  const job = mockJob(a); const running = a.tick(); await entered.promise;
  try {
    const b = new Service(f.connect(), { stepMs: 0, pdf: async () => { calls++; return Buffer.from('%PDF-other'); } });
    assert.equal(b.store.get('job', job.id).status, 'validating');
    await b.tick(); assert.equal(calls, 1);
  } finally { release.resolve(); await running; }
  assert.equal(a.store.get('job', job.id).status, 'succeeded');
  assert.equal(a.store.lease(job.id), undefined);
});

test('真实请求的 attempt 在网络调用之前落库，心跳续租阻止第二个执行器接管', async t => {
  const f = fixture(t); const entered = deferred(); const release = deferred(); let calls = 0;
  const store = f.connect();
  const registry = createAdapterRegistry({ pythonAdapterUrl: 'http://offline', transport: async (_, request) => {
    calls++; assert.equal(store.get('job', request.jobId).executionAttempt.id, request.attemptId);
    entered.resolve(); await release.promise; return candidate(request);
  } });
  const a = new Service(store, { stepMs: 0, leaseMs: 150, registry });
  const job = realJob(a); const running = a.tick(); await entered.promise;
  const first = store.lease(job.id);
  try {
    await delay(220);
    assert.ok(store.lease(job.id).heartbeat > first.heartbeat);
    assert.ok(store.lease(job.id).expires > Date.now());
    const b = new Service(f.connect(), { stepMs: 0, registry });
    await b.tick(); assert.equal(calls, 1); assert.equal(store.get('job', job.id).status, 'running');
  } finally { release.resolve(); await running; }
  assert.equal(store.get('job', job.id).status, 'validating');
});

test('真实执行租约过期转人工，迟到结果不能恢复状态或再次提交', async t => {
  const f = fixture(t); const entered = deferred(); const release = deferred(); let now = Date.now(); let calls = 0;
  const registry = createAdapterRegistry({ pythonAdapterUrl: 'http://offline', transport: async (_, request) => {
    calls++; entered.resolve(); await release.promise; return candidate(request);
  } });
  const a = new Service(f.connect(), { stepMs: 0, now: () => now, registry });
  const b = new Service(f.connect(), { stepMs: 0, now: () => now, registry });
  const job = realJob(a); const running = a.tick(); await entered.promise;
  try {
    now += 30001; await b.tick();
    assert.equal(b.store.get('job', job.id).status, 'awaiting_manual');
    assert.equal(b.store.get('job', job.id).error, 'RESULT_UNKNOWN');
  } finally { release.resolve(); await running; }
  await a.tick(); await b.tick();
  assert.equal(calls, 1); assert.equal(a.store.readArtifact(job.id), null);
  assert.equal(a.store.get('job', job.id).status, 'awaiting_manual');
});

test('结果落库失败后保留 durable attempt，下一次 tick 不重提真实请求', async t => {
  const f = fixture(t); let calls = 0;
  const registry = createAdapterRegistry({ pythonAdapterUrl: 'http://offline', transport: async (_, request) => { calls++; return candidate(request); } });
  const store = f.connect(); const service = new Service(store, { stepMs: 0, registry }); const job = realJob(service);
  const put = store.put.bind(store);
  store.put = (kind, value) => { if (kind === 'event' && value.type === 'proposal.validating') throw new Error('storage fault'); return put(kind, value); };
  await assert.rejects(service.tick(), /storage fault/);
  assert.ok(store.get('job', job.id).executionAttempt.id);
  store.put = put;
  await service.tick();
  assert.equal(calls, 1); assert.equal(store.get('job', job.id).status, 'awaiting_manual');
});

test('过期模拟租约可以重新执行，但旧持有者不能覆盖文件或释放新租约', async t => {
  const f = fixture(t); const entered = deferred(); const release = deferred(); let now = Date.now();
  const a = new Service(f.connect(), { stepMs: 0, now: () => now, pdf: async () => { entered.resolve(); await release.promise; return Buffer.from('%PDF-old'); } });
  const b = new Service(f.connect(), { stepMs: 0, now: () => now, pdf: async () => Buffer.from('%PDF-new') });
  const job = mockJob(a); const running = a.tick(); await entered.promise;
  const old = a.store.lease(job.id);
  try {
    now += 30001;
    const claim = b.claimWork(); assert.ok(claim);
    a.store.releaseLease(old);
    assert.equal(b.store.lease(job.id).token, claim.lease.token);
    b.applyOutcome(claim.job, { kind: 'artifact', bytes: Buffer.from('%PDF-new'), text: 'new owner' });
    b.store.releaseLease(claim.lease);
  } finally { release.resolve(); await running; }
  assert.equal(a.store.readArtifact(job.id).toString(), '%PDF-new');
});

test('adapter 修改收到的快照不会污染持久任务', async t => {
  const f = fixture(t);
  const adapter = { isMock: true, async advance(job) { job.ownerId = 'other'; job.params.age = 99; return { kind: 'transition', status: 'running', text: 'test' }; } };
  const service = new Service(f.connect(), { stepMs: 0, registry: { ...createAdapterRegistry(), resolve: () => adapter } });
  const job = mockJob(service, 'queued'); await service.tick();
  assert.equal(service.store.get('job', job.id).params.age, 35);
  assert.equal(service.store.get('job', job.id).ownerId, demoActors.broker.id);
});

test('SQLite 嵌套事务回滚保留外层操作，外层失败仍撤销全部写入', t => {
  const store = fixture(t).connect();
  const record = id => ({ id, ownerId: 'o', tenantId: 't' });
  store.transaction(() => {
    store.put('test', record('a'));
    assert.throws(() => store.transaction(() => { store.put('test', record('b')); throw new Error('inner'); }), /inner/);
    store.put('test', record('c'));
  });
  assert.deepEqual(store.list('test').map(r => r.id).sort(), ['a', 'c']);
  assert.throws(() => store.transaction(() => { store.transaction(() => store.put('test', record('d'))); throw new Error('outer'); }), /outer/);
  assert.equal(store.get('test', 'd'), null);
  assert.equal(store.transactionDepth, 0);
});

test('失去租约会中止 Python transport，下一轮转人工而不重提', async t => {
  const f = fixture(t); const entered = deferred(); let signal; let calls = 0;
  const registry = createAdapterRegistry({ pythonAdapterUrl: 'http://offline', transport: (_, request, options) => {
    calls++; signal = options.signal; entered.resolve(); return new Promise(() => {});
  } });
  const service = new Service(f.connect(), { stepMs: 0, leaseMs: 90, registry });
  const job = realJob(service); const running = service.tick(); await entered.promise;
  service.store.releaseLease(service.store.lease(job.id));
  await delay(50); await running;
  assert.equal(signal.aborted, true);
  await service.tick();
  assert.equal(service.store.get('job', job.id).status, 'awaiting_manual');
  assert.equal(calls, 1);
});

test('两个独立 Node 进程共享数据库时同一 PDF 仅执行一次', { timeout: 10000 }, async t => {
  const f = fixture(t); const service = new Service(f.connect(), { stepMs: 0 }); const job = mockJob(service);
  const children = []; const renders = [];
  const workers = [0, 1].map(index => {
    const ready = deferred(), done = deferred();
    const child = fork(new URL('./helpers/lease-worker.mjs', import.meta.url), [f.database], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    child.on('message', message => {
      if (message === 'ready') ready.resolve();
      if (message === 'render') renders.push(index);
      if (message === 'done') done.resolve();
    });
    return { child, ready, done };
  });
  try {
    await Promise.all(workers.map(w => w.ready.promise));
    for (const w of workers) w.child.send('tick');
    // The losing process completes without rendering while the winner waits.
    await Promise.race(workers.map(w => w.done.promise));
    // IPC from the winner can arrive after the loser's completion message.
    for (let i = 0; renders.length === 0 && i < 100; i++) await delay(5);
    assert.equal(renders.length, 1);
    workers[renders[0]].child.send('release');
    await Promise.all(workers.map(w => w.done.promise));
    assert.equal(renders.length, 1);
    assert.equal(service.store.get('job', job.id).status, 'succeeded');
    assert.equal(service.store.list('event').filter(e => e.type === 'proposal.succeeded').length, 1);
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.kill(); await exited;
    }));
  }
});
