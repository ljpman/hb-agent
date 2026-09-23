import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';

import { demoActors, product } from '../server/catalog.mjs';
import { AppError } from '../server/errors.mjs';
import { Service } from '../server/service.mjs';
import { Store } from '../server/store.mjs';
import { createAdapterRegistry } from '../server/adapters/registry.mjs';
import { PythonInsurerAdapter } from '../server/adapters/python-adapter.mjs';

const iso = time => new Date(time).toISOString();

function serviceWith(registry) {
  let clock = Date.parse('2026-09-22T01:00:00.000Z');
  const store = new Store(':memory:');
  const service = new Service(store, { now: () => clock, stepMs: 0, registry, pdf: async job => Buffer.from(`%PDF-1.4\n${job.id}`) });
  return { service, store, now: () => clock, advance(ms = 1) { clock += ms; } };
}

// A persisted real (python) job, injected directly to exercise the state machine
// without needing a multi-product catalog (that lands in a later milestone).
function putRealJob(store, now, overrides = {}) {
  const base = {
    id: 'job-real-1', tenantId: 'demo-agency', ownerId: 'broker-lin', clientId: 'client-chen', draftId: 'draft-real-1',
    params: { age: 35 }, paramsHash: 'hash-real', productId: 'real-product', productVersion: 'v1', schemaVersion: '1',
    version: 1, scenario: 'success', execution: { mode: 'python' }, status: 'queued', isMock: false,
    createdAt: iso(now), updatedAt: iso(now), nextAt: now, confirmedAt: iso(now), confirmedBy: '林经理',
    history: [{ status: 'queued', at: iso(now), text: '注入的真实任务' }],
  };
  return store.put('job', { ...base, ...overrides });
}

test('registry：演示产品走 mock，真实产品未配置不回退 mock', () => {
  const dev = createAdapterRegistry();
  assert.equal(dev.describe({ execution: { mode: 'mock' } }).isMock, true);
  const real = dev.describe({ execution: { mode: 'python' } });
  assert.equal(real.isMock, false);
  assert.equal(real.available, false);
  assert.equal(dev.status().python, 'awaiting-hong-kong');

  // strict（生产）+ 未配置真实执行服务 → 拒绝创建，不静默回退 mock。
  const strict = createAdapterRegistry({ strict: true });
  assert.throws(() => strict.resolveForProduct({ execution: { mode: 'python' } }), e => e instanceof AppError && e.code === 'PRODUCT_UNAVAILABLE');

  // 配置端点后可创建，且诚实标注已配置。
  const configured = createAdapterRegistry({ pythonAdapterUrl: 'http://hk.example', strict: true });
  const info = configured.resolveForProduct({ execution: { mode: 'python' } });
  assert.equal(info.isMock, false);
  assert.equal(info.available, true);
  assert.equal(configured.status().python, 'configured');
});

test('PythonInsurerAdapter：只做契约映射，凭据仅传引用，从不自动交付真实文件', async () => {
  let captured;
  const responses = { next: null };
  const transport = async (endpoint, request) => { captured = request; if (responses.throw) throw new Error('net'); return { jobId: request.jobId, attemptId: request.attemptId, isMock: false, ...responses.next }; };
  const adapter = new PythonInsurerAdapter({ endpoint: 'http://hk.example', transport });
  const job = {
    id: 'job-1', productId: 'p', productVersion: 'v', schemaVersion: '1', draftId: 'draft-1',
    paramsHash: 'h', params: { age: 35 }, credentialRef: 'cred-ref-001',
  };

  // queued → running
  assert.equal((await adapter.advance({ ...job, status: 'queued' })).status, 'running');

  // running + 成功候选 → validating（未核验，不 succeeded）；请求携带契约字段与凭据引用。
  responses.next = { status: 'validating', isMock: false, artifactRef: 'ref-1', source: { insurerId: 'x', productId: 'p', productVersion: 'v' }, validation: { status: 'pending', mismatches: [] } };
  const running = await adapter.advance({ ...job, status: 'running' });
  assert.equal(running.status, 'validating');
  assert.equal(captured.jobId, 'job-1');
  assert.equal(captured.paramsHash, 'h');
  assert.equal(captured.confirmationRef, 'draft-1');
  assert.equal(captured.credentialRef, 'cred-ref-001');
  assert.ok(captured.attemptId && captured.attemptId.startsWith('job-1-attempt-'));
  assert.ok(!('password' in captured) && !('cookie' in captured));

  // 错误码映射（契约 §5）。
  responses.next = { error: 'PARAM_INVALID' };
  assert.equal((await adapter.advance({ ...job, status: 'running' })).status, 'failed');
  responses.next = { error: 'AUTH_REQUIRED' };
  let o = await adapter.advance({ ...job, status: 'running' });
  assert.equal(o.status, 'awaiting_manual');
  assert.equal(o.error, 'AUTH_REQUIRED');
  responses.next = { error: 'PDF_MISMATCH' };
  assert.equal((await adapter.advance({ ...job, status: 'running' })).error, 'PDF_MISMATCH');
  responses.next = { error: 'TRANSIENT_NETWORK_ERROR' };
  assert.equal((await adapter.advance({ ...job, status: 'running' })).status, 'awaiting_manual');

  // 真实服务返回模拟标识 → 阻止交付。
  responses.next = { status: 'validating', isMock: true };
  assert.equal((await adapter.advance({ ...job, status: 'running' })).error, 'ADAPTER_MISMATCH');

  // 调用失败（网络异常）→ 结果未知，转人工，不盲目重试。
  responses.throw = true;
  o = await adapter.advance({ ...job, status: 'running' });
  assert.equal(o.status, 'awaiting_manual');
  assert.equal(o.error, 'RESULT_UNKNOWN');
  responses.throw = false;

  // validating 永不自动成功（真实核验规则待 M1b）。
  assert.equal((await adapter.advance({ ...job, status: 'validating' })).status, 'awaiting_manual');

  // 未配置端点 → 转人工，不回退 mock。
  const bare = new PythonInsurerAdapter({ endpoint: null });
  assert.equal((await bare.advance({ ...job, status: 'queued' })).error, 'ADAPTER_NOT_CONFIGURED');
});

test('tick：真实产品未配置执行服务时转人工，且不生成模拟 PDF', async () => {
  const ctx = serviceWith(createAdapterRegistry()); // python 未配置
  putRealJob(ctx.store, ctx.now());
  await ctx.service.tick(); // queued → running
  await ctx.service.tick(); // running → 未配置 → awaiting_manual
  const job = ctx.store.get('job', 'job-real-1');
  assert.equal(job.status, 'awaiting_manual');
  assert.equal(job.error, 'ADAPTER_NOT_CONFIGURED');
  assert.equal(job.isMock, false);
  assert.equal(ctx.store.readArtifact('job-real-1'), null);
  ctx.store.close();
});

test('recover：真实任务重启后进入人工核实，不当作可安全重做', () => {
  const ctx = serviceWith(createAdapterRegistry());
  putRealJob(ctx.store, ctx.now(), { status: 'running' });
  ctx.service.recover();
  const job = ctx.store.get('job', 'job-real-1');
  assert.equal(job.status, 'awaiting_manual');
  assert.equal(job.error, 'RESULT_UNKNOWN');
  ctx.store.close();
});

test('演示产品经 registry 创建仍诚实标注为模拟', () => {
  const ctx = serviceWith(createAdapterRegistry());
  const draft = ctx.service.createDraft(demoActors.broker, {
    clientId: 'client-chen', productId: product.id, schemaVersion: product.schemaVersion,
    params: { age: 35, gender: '男', smoker: false, currency: 'USD', annualPremium: 10_000, paymentTerm: '5' },
  });
  const job = ctx.service.createJob(demoActors.broker, {
    draftId: draft.id, revision: draft.revision, paramsHash: draft.paramsHash, confirmed: true,
  }, 'idem-demo-adapter-1');
  assert.equal(job.isMock, true);
  assert.equal(job.execution.mode, 'mock');
  ctx.store.close();
});

test('Python 结果必须绑定本次任务和产品；不信任远端核验或保存额外字段', async () => {
  const job = { id: 'job-1', status: 'running', productId: 'p', productVersion: 'v', execution: { mode: 'python', insurerId: 'insurer' } };
  const candidate = request => ({ jobId: request.jobId, attemptId: request.attemptId, isMock: false,
    status: 'validating', artifactRef: 'artifact-1', source: { insurerId: 'insurer', productId: 'p', productVersion: 'v' } });
  const invalid = [
    () => null, () => ({}), () => [],
    r => ({ ...candidate(r), jobId: 'other-job' }),
    r => ({ ...candidate(r), attemptId: 'old-attempt' }),
    r => ({ ...candidate(r), isMock: undefined }),
    r => ({ ...candidate(r), isMock: 'false' }),
    ...['queued', 'running', 'succeeded', 'failed', 'awaiting_manual'].map(status => r => ({ ...candidate(r), status })),
    ...['', '/etc/passwd', '../other.pdf', 'https://example.com/file.pdf', 'a'.repeat(201)].map(artifactRef => r => ({ ...candidate(r), artifactRef })),
    ...[null, { insurerId: 'other', productId: 'p', productVersion: 'v' },
      { insurerId: 'insurer', productId: 'other', productVersion: 'v' },
      { insurerId: 'insurer', productId: 'p', productVersion: 'old' }].map(source => r => ({ ...candidate(r), source })),
    r => ({ ...candidate(r), jobId: 'other-job', error: 'PARAM_INVALID' }),
    r => ({ ...candidate(r), error: 'toString' }),
    r => ({ ...candidate(r), error: '__proto__' }),
  ];
  for (const response of invalid) {
    const adapter = new PythonInsurerAdapter({ endpoint: 'http://unused', transport: async (_, request) => response(request) });
    const result = await adapter.advance(job);
    assert.equal(result.status, 'awaiting_manual');
    assert.equal(result.error, 'RESULT_UNKNOWN');
    assert.equal(result.patch, undefined);
  }
  const adapter = new PythonInsurerAdapter({ endpoint: 'http://unused', transport: async (_, request) => {
    const result = candidate(request);
    result.source.cookie = 'remote-secret';
    return { ...result, password: 'remote-secret', validation: { status: 'passed', rawText: 'remote-secret' } };
  } });
  const result = await adapter.advance(job);
  assert.equal(result.status, 'validating');
  assert.deepEqual(result.patch.validation, { status: 'pending', mismatches: [] });
  assert.equal(JSON.stringify(result).includes('remote-secret'), false);
});

test('Python 调用超时释放队列，迟到结果不交付、不重提，后续模拟任务可继续', async () => {
  let calls = 0; let signal; let complete;
  const adapter = new PythonInsurerAdapter({ endpoint: 'http://unused', timeoutMs: 15,
    transport: (_, request, options) => {
      calls++; signal = options.signal;
      return new Promise(resolve => { complete = () => resolve({ jobId: request.jobId, attemptId: request.attemptId, status: 'validating', isMock: false }); });
    } });
  const base = createAdapterRegistry();
  const ctx = serviceWith({ ...base, resolve: job => job.isMock ? base.resolve(job) : adapter });
  putRealJob(ctx.store, ctx.now(), { status: 'running' });
  await ctx.service.tick();
  assert.equal(signal.aborted, true);
  assert.equal(ctx.service.busy, false);
  assert.equal(ctx.store.get('job', 'job-real-1').status, 'awaiting_manual');
  assert.equal(ctx.store.get('job', 'job-real-1').error, 'RESULT_UNKNOWN');
  complete();
  await ctx.service.tick();
  assert.equal(calls, 1);
  assert.equal(ctx.store.readArtifact('job-real-1'), null);
  const draft = ctx.service.createDraft(demoActors.broker, { clientId: 'client-chen', productId: product.id,
    schemaVersion: product.schemaVersion, params: { age: 35, gender: '男', smoker: false, currency: 'USD', annualPremium: '10000', paymentTerm: '5' } });
  const mock = ctx.service.createJob(demoActors.broker, { draftId: draft.id, revision: draft.revision, paramsHash: draft.paramsHash, confirmed: true }, 'timeout-followup');
  for (let i = 0; i < 3; i++) await ctx.service.tick();
  assert.equal(ctx.store.get('job', mock.id).status, 'succeeded');
  assert.equal(ctx.store.get('job', 'job-real-1').status, 'awaiting_manual');
  ctx.store.close();
});

test('Python 调用超时配置必须有效', () => {
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    assert.throws(() => new PythonInsurerAdapter({ timeoutMs }), TypeError);
  }
});

test('Python 默认 HTTP transport：拒绝重定向并中止未响应请求', async t => {
  let redirected = 0;
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(307, { location: '/target' }); res.end(); }
    else if (req.url === '/target') { redirected++; res.end('{}'); }
    // /hang deliberately never responds; the adapter must abort this request.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/redirect', '/hang']) {
    const adapter = new PythonInsurerAdapter({ endpoint: url + route, timeoutMs: route === '/hang' ? 30 : 1000 });
    const result = await adapter.advance({ id: 'http-job', status: 'running' });
    assert.equal(result.status, 'awaiting_manual');
    assert.equal(result.error, 'RESULT_UNKNOWN');
  }
  assert.equal(redirected, 0);
});
