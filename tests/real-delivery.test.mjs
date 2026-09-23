import assert from 'node:assert/strict';
import test from 'node:test';

import { demoActors } from '../server/catalog.mjs';
import { Service } from '../server/service.mjs';
import { Store } from '../server/store.mjs';
import { createAdapterRegistry } from '../server/adapters/registry.mjs';
import { PythonInsurerAdapter } from '../server/adapters/python-adapter.mjs';
import { createPdfVerifier } from '../server/verify/pdf-verifier.mjs';

// Offline checks for the M1b delivery gate. No real Hong Kong service, portal,
// product rule or official PDF is involved: the rule below is a test fixture.
const iso = time => new Date(time).toISOString();
const pdf = marker => Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Note (${marker}) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
const fields = [{ key: 'age', type: 'integer' }, { key: 'smoker', type: 'boolean' }, { key: 'annualPremium', type: 'decimal' }];
const params = { age: 35, smoker: false, annualPremium: '10000.00' };
// Test-only rule: reads "age=..;smoker=..;premium=.." markers from the fixture PDF.
const fixtureRule = {
  productId: 'real-product', productVersion: 'v1',
  extract({ bytes }) {
    const text = bytes.toString('latin1');
    const read = key => text.match(new RegExp(`${key}=([^;)]+)`))?.[1];
    return {
      productVersion: { value: read('version'), page: 1 },
      fields: { age: { value: read('age'), page: 1 }, smoker: { value: read('smoker') === 'Y', page: 1 }, annualPremium: { value: read('premium'), page: 2 } },
    };
  },
};
const matching = pdf('version=v1;age=35;smoker=N;premium=10,000.00');

function setup({ fetchArtifact, rules = [fixtureRule], artifactRef = 'artifact-1' } = {}) {
  let clock = Date.parse('2026-09-23T01:00:00.000Z');
  const store = new Store(':memory:');
  const calls = { submit: 0, fetch: [] };
  const adapter = new PythonInsurerAdapter({
    endpoint: 'http://unused',
    transport: async (_, request) => {
      calls.submit++;
      return { jobId: request.jobId, attemptId: request.attemptId, isMock: false, status: 'validating', artifactRef,
        source: { insurerId: 'insurer-x', productId: request.productId, productVersion: request.productVersion } };
    },
    ...(fetchArtifact === undefined ? {} : { fetchArtifact: fetchArtifact && (async (ref, options) => { calls.fetch.push(ref); return fetchArtifact(ref, options); }) }),
  });
  const base = createAdapterRegistry();
  const registry = { ...base, resolve: job => job.isMock ? base.resolve(job) : adapter };
  const service = new Service(store, { now: () => clock, stepMs: 0, registry, verifier: createPdfVerifier({ rules }) });
  store.put('job', {
    id: 'job-real-1', tenantId: demoActors.broker.tenantId, ownerId: demoActors.broker.id, clientId: 'client-chen', draftId: 'draft-real-1',
    params, paramsHash: 'hash-real', productId: 'real-product', productVersion: 'v1', schemaVersion: '1',
    productSnapshot: { id: 'real-product', version: 'v1', fields }, credentialRef: 'cred-ref-hk-1',
    version: 1, scenario: 'success', execution: { mode: 'python', insurerId: 'insurer-x' }, status: 'queued', isMock: false,
    createdAt: iso(clock), updatedAt: iso(clock), nextAt: clock, confirmedAt: iso(clock), confirmedBy: '林经理',
    history: [{ status: 'queued', at: iso(clock), text: '注入的真实任务' }],
  });
  const held = () => store.db.prepare('SELECT job_id FROM execution_resources').all().map(row => row.job_id);
  const job = () => store.get('job', 'job-real-1');
  const run = async (n = 3) => { for (let i = 0; i < n; i++) { await service.tick(); clock += 1; } };
  const events = type => store.list('event').filter(event => event.type === type);
  return { store, service, calls, held, job, run, events };
}

test('真实候选文件通过确定性核验后才成功：可下载、记录证据、释放账号', async () => {
  const ctx = setup({ fetchArtifact: async () => matching });
  await ctx.run();
  const job = ctx.job();
  assert.equal(job.status, 'succeeded');
  assert.equal(job.isMock, false);
  assert.deepEqual(job.history.map(h => h.status), ['queued', 'running', 'validating', 'succeeded']);
  assert.equal(ctx.calls.submit, 1);
  assert.deepEqual(ctx.calls.fetch, [{ jobId: 'job-real-1', attemptId: job.executionAttempt.id, artifactRef: 'artifact-1' }]);
  assert.equal(job.validation.status, 'passed');
  assert.equal(job.validation.ruleSet, 'real-product@v1');
  assert.deepEqual(job.validation.checks.map(c => [c.field, c.match]), [['productVersion', true], ['age', true], ['smoker', true], ['annualPremium', true]]);
  assert.equal(JSON.stringify(job.validation).includes('10,000'), false, '不保存从 PDF 读出的数值');
  assert.deepEqual(ctx.service.readPdf(demoActors.broker, 'job-real-1'), matching);
  assert.equal(job.artifactHash, job.validation.fileSha256);
  assert.deepEqual(ctx.held(), []);
  assert.equal(ctx.events('execution.account-released').length, 1);
  // 讲解包模板仍是演示内容，不为真实文件生成。
  assert.throws(() => ctx.service.package(demoActors.broker, 'job-real-1'), e => e.code === 'PACKAGE_NOT_READY');
  ctx.store.close();
});

test('参数不一致、登录页、非 PDF 都判核验失败：阻止交付并保留账号占用', async () => {
  const candidates = [
    pdf('version=v1;age=35;smoker=N;premium=10,000.01'),
    pdf('version=v1;age=35;smoker=Y;premium=10,000.00'),
    pdf('version=v2;age=35;smoker=N;premium=10,000.00'),
    Buffer.from('<!DOCTYPE html><html><title>Portal login</title></html>'),
    Buffer.from('%PDF-1.7\ntruncated'),
  ];
  for (const bytes of candidates) {
    const ctx = setup({ fetchArtifact: async () => bytes });
    await ctx.run();
    const job = ctx.job();
    assert.equal(job.status, 'awaiting_manual');
    assert.equal(job.error, 'PDF_MISMATCH');
    assert.equal(job.validation.status, 'mismatch');
    assert.equal(ctx.store.readArtifact('job-real-1'), null);
    assert.throws(() => ctx.service.readPdf(demoActors.broker, 'job-real-1'), e => e.code === 'NOT_READY');
    assert.deepEqual(ctx.held(), ['job-real-1']);
    ctx.store.close();
  }
});

test('没有核验规则、未配置取回或取回失败时转人工，结果未知，不交付', async () => {
  const cases = [
    { rules: [], fetchArtifact: async () => matching },
    { fetchArtifact: null },
    { fetchArtifact: async () => { throw new Error('download failed'); } },
    { fetchArtifact: async () => 'not bytes' },
    { fetchArtifact: async () => matching, artifactRef: 'ref/../other' },
  ];
  for (const options of cases) {
    const ctx = setup(options);
    await ctx.run();
    const job = ctx.job();
    assert.equal(job.status, 'awaiting_manual');
    assert.equal(job.error, 'RESULT_UNKNOWN');
    assert.equal(ctx.store.readArtifact('job-real-1'), null);
    assert.deepEqual(ctx.held(), ['job-real-1']);
    ctx.store.close();
  }
});

test('核验器异常视为无法核验；取回超时中止并转人工', async () => {
  const ctx = setup({ fetchArtifact: async () => matching });
  ctx.service.verifier = { verify: async () => { throw new Error('verifier crashed'); } };
  await ctx.run();
  assert.equal(ctx.job().status, 'awaiting_manual');
  assert.equal(ctx.job().error, 'RESULT_UNKNOWN');
  ctx.store.close();

  let aborted = false;
  const slow = setup({ fetchArtifact: (_, { signal }) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }) });
  slow.service.registry.resolve({ isMock: false }).timeoutMs = 15;
  await slow.run();
  assert.equal(aborted, true);
  assert.equal(slow.job().status, 'awaiting_manual');
  assert.equal(slow.job().error, 'RESULT_UNKNOWN');
  slow.store.close();
});

test('adapter 不能自行批准：真实任务的 artifact、伪造核验结果、错配引用与模拟任务候选均被拒绝', async () => {
  const outcomes = [
    { kind: 'artifact', bytes: matching, text: 'self approved' },
    { kind: 'candidate', artifactRef: 'artifact-1', bytes: matching, verification: { status: 'passed' } },
    { kind: 'candidate', artifactRef: 'other-artifact', bytes: matching },
    { kind: 'candidate', artifactRef: 'artifact-1', bytes: 'not a buffer' },
  ];
  for (const outcome of outcomes) {
    const ctx = setup({ fetchArtifact: async () => matching, rules: [] });
    await ctx.run(2); // queued → running → validating
    assert.equal(ctx.job().status, 'validating');
    const adapter = ctx.service.registry.resolve({ isMock: false });
    adapter.advance = async () => outcome;
    await ctx.run(1);
    assert.equal(ctx.job().status, 'awaiting_manual');
    assert.equal(ctx.job().error, 'RESULT_UNKNOWN');
    assert.equal(ctx.store.readArtifact('job-real-1'), null);
    ctx.store.close();
  }
  // Service.applyOutcome also refuses a verification whose hash does not match the bytes.
  const ctx = setup({ fetchArtifact: async () => matching });
  await ctx.run(2);
  const job = ctx.job();
  ctx.store.transaction(() => ctx.service.applyOutcome(job, { kind: 'candidate', artifactRef: 'artifact-1', bytes: matching },
    { status: 'passed', fileSha256: 'f'.repeat(64), checks: [{ field: 'age', page: 1, match: true }] }));
  assert.equal(ctx.job().status, 'awaiting_manual');
  assert.equal(ctx.store.readArtifact('job-real-1'), null);
  ctx.store.close();

  // A mock job can never take the real candidate path.
  const mock = setup({ fetchArtifact: async () => matching });
  const mockJob = { ...mock.job(), isMock: true, status: 'validating', artifactRef: 'artifact-1' };
  mock.store.put('job', mockJob);
  mock.store.transaction(() => mock.service.applyOutcome(mockJob, { kind: 'candidate', artifactRef: 'artifact-1', bytes: matching }, null));
  assert.equal(mock.job().status, 'awaiting_manual');
  mock.store.close();
});

test('核验失败时账号继续占用，同账号任务不进入门户；运营核实关闭后才继续', async () => {
  const mismatched = pdf('version=v1;age=36;smoker=N;premium=10,000.00');
  const ctx = setup({ fetchArtifact: async ({ jobId }) => jobId === 'job-real-1' ? mismatched : matching });
  ctx.store.put('job', { ...ctx.job(), id: 'job-real-2', draftId: 'draft-real-2', history: [] });
  const statuses = () => ['job-real-1', 'job-real-2'].map(id => ctx.store.get('job', id).status);
  await ctx.run(10);
  assert.deepEqual(statuses(), ['awaiting_manual', 'queued']);
  assert.equal(ctx.job().error, 'PDF_MISMATCH');
  assert.equal(ctx.calls.submit, 1);
  assert.deepEqual(ctx.held(), ['job-real-1']);
  ctx.service.resolve(demoActors.operator, 'job-real-1', { action: 'close', note: '已在门户核实并作废该计划书', portalChecked: true });
  await ctx.run(3);
  assert.deepEqual(statuses(), ['failed', 'succeeded']);
  assert.equal(ctx.calls.submit, 2);
  assert.deepEqual(ctx.held(), []);
  ctx.store.close();
});
