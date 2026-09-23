// Exercise the real local PDF renderer and HTTP workflow in a disposable DB.
// No insurer, Dify or other external service is called.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../server/index.mjs';

const directory = await mkdtemp(join(tmpdir(), 'hb-smoke-'));
let app;
let origin;
let cookie;
async function start() {
  app = createApp({ database: join(directory, 'smoke.sqlite'), tick: false, serviceOptions: { stepMs: 0 } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${app.server.address().port}`;
}
async function request(path, { method = 'GET', data, expected = 200, headers = {} } = {}) {
  const response = await fetch(origin + path, { method,
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  assert.equal(response.status, expected, `${method} ${path}: ${response.status}`);
  return response;
}
try {
  await start();
  const session = await request('/api/demo/session', { method: 'POST', data: { actor: 'broker' } });
  cookie = session.headers.get('set-cookie').split(';')[0];
  const draft = await (await request('/api/proposal-drafts', { method: 'POST', expected: 201, data: {
    clientId: 'client-chen', productId: 'demo-savings-01', schemaVersion: '1',
    params: { age: 35, gender: '男', smoker: false, currency: 'USD', annualPremium: '10000.00', paymentTerm: '5' },
  } })).json();
  const submission = { method: 'POST', expected: 202, headers: { 'idempotency-key': 'smoke-confirm-001' },
    data: { draftId: draft.id, revision: draft.revision, paramsHash: draft.paramsHash, confirmed: true } };
  const job = await (await request('/api/proposals', submission)).json();
  await request(`/api/proposals/${job.id}/download`, { expected: 409 });
  for (let i = 0; i < 3; i++) await app.service.tick();
  const finished = await (await request(`/api/proposals/${job.id}`)).json();
  assert.equal(finished.status, 'succeeded', JSON.stringify({ status: finished.status, error: finished.error }));
  assert.equal(finished.isMock, true);
  const bytes = Buffer.from(await (await request(`/api/proposals/${job.id}/download`)).arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.length > 1000, 'PDF should come from the actual renderer');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), finished.artifactHash);
  const pack = await (await request(`/api/packages/${job.id}`)).json();
  await request(`/api/packages/${job.id}/export`, { expected: 409 });
  await request(`/api/packages/${job.id}/review`, { method: 'POST', data: { revision: pack.revision, confirmed: true } });
  assert.match(await (await request(`/api/packages/${job.id}/export`)).text(), /模拟材料/);
  await app.close(); app = null;
  await start();
  assert.equal((await (await request('/api/proposals', submission)).json()).id, job.id);
  const recovered = Buffer.from(await (await request(`/api/proposals/${job.id}/download`)).arrayBuffer());
  assert.deepEqual(recovered, bytes);
  await request(`/api/packages/${job.id}/export`);
  console.log(`PASS: HTTP confirmation → actual mock PDF (${bytes.length} bytes) → review/export → restart/download/idempotency`);
} finally {
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
