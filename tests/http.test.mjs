import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../server/index.mjs';

async function start() {
  const app = createApp({ database: ':memory:', tick: false, serviceOptions: { stepMs: 0, pdf: async () => Buffer.from('%PDF-1.4\ntest') } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  return { ...app, origin: `http://127.0.0.1:${port}` };
}

test('HTTP 会话使用 HttpOnly Cookie，修改请求必须同源', async () => {
  const app = await start();
  try {
    const denied = await fetch(`${app.origin}/api/demo/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'broker' }),
    });
    assert.equal(denied.status, 403);

    const session = await fetch(`${app.origin}/api/demo/session`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: app.origin }, body: JSON.stringify({ actor: 'broker' }),
    });
    assert.equal(session.status, 200);
    const cookie = session.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);

    const bootstrap = await fetch(`${app.origin}/api/bootstrap`, { headers: { cookie } });
    assert.equal(bootstrap.status, 200);
    const payload = await bootstrap.json();
    assert.equal(payload.actor.id, 'broker-lin');
    assert.equal(payload.clients.length, 3);
  } finally { await app.close(); }
});

test('HTTP 参数确认接口拒绝缺少必填字段的请求', async () => {
  const app = await start();
  try {
    const session = await fetch(`${app.origin}/api/demo/session`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: app.origin }, body: JSON.stringify({ actor: 'broker' }),
    });
    const cookie = session.headers.get('set-cookie');
    const response = await fetch(`${app.origin}/api/proposal-drafts`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: app.origin },
      body: JSON.stringify({ clientId: 'client-chen', productId: 'demo-savings-01', schemaVersion: '1', params: { age: 35 } }),
    });
    assert.equal(response.status, 422);
    const payload = await response.json();
    assert.equal(payload.error.code, 'PARAM_INVALID');
    assert.match(payload.error.details.gender, /请填写/);
  } finally { await app.close(); }
});

test('HTTP 完整闭环：确认、权限隔离、下载、复核导出与新版本失效', async () => {
  const app = await start();
  try {
    async function login(actor) {
      const res = await fetch(`${app.origin}/api/demo/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: app.origin }, body: JSON.stringify({ actor }) });
      assert.equal(res.status, 200); return res.headers.get('set-cookie').split(';')[0];
    }
    const broker = await login('broker');
    const colleague = await login('colleague');
    const other = await login('other');
    const operator = await login('operator');
    const request = (path, cookie = broker, method = 'GET', input, headers = {}) => fetch(app.origin + path, {
      method, headers: { cookie, origin: app.origin, 'content-type': 'application/json', ...headers },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    async function draft() {
      const res = await request('/api/proposal-drafts', broker, 'POST', { clientId: 'client-chen', productId: 'demo-savings-01', schemaVersion: '1',
        params: { age: 35, gender: '男', smoker: false, currency: 'USD', annualPremium: '10000', paymentTerm: '5' } });
      assert.equal(res.status, 201); return res.json();
    }
    async function submit(d, key) {
      const res = await request('/api/proposals', broker, 'POST', { draftId: d.id, revision: d.revision, paramsHash: d.paramsHash, confirmed: true }, { 'idempotency-key': key });
      assert.equal(res.status, 202); return res.json();
    }
    assert.equal((await fetch(app.origin + '/api/proposals')).status, 401);
    const d = await draft(); const job = await submit(d, 'http-full-flow');
    assert.equal((await submit(d, 'http-full-flow')).id, job.id);
    assert.equal((await request(`/api/proposals/${job.id}/download`)).status, 409);
    for (let i = 0; i < 3; i++) await app.service.tick();
    const download = await request(`/api/proposals/${job.id}/download`);
    assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'application/pdf');
    assert.match(await download.text(), /^%PDF-/);
    const paths = [`/api/proposals/${job.id}`, `/api/proposals/${job.id}/download`, `/api/packages/${job.id}`, `/api/packages/${job.id}/export`];
    for (const cookie of [colleague, other]) {
      for (const path of paths) assert.equal((await request(path, cookie)).status, 404);
      const bootstrap = await (await request('/api/bootstrap', cookie)).json();
      assert.equal(bootstrap.jobs.length, 0);
      assert.equal(bootstrap.events.length, 0);
    }
    let pack = await (await request(`/api/packages/${job.id}`)).json();
    assert.equal((await request(`/api/packages/${job.id}/export`)).status, 409);
    assert.equal((await request(`/api/packages/${job.id}/review`, operator, 'POST', { revision: pack.revision, confirmed: true })).status, 403);
    pack = await (await request(`/api/packages/${job.id}`, broker, 'PATCH', { revision: pack.revision, note: '<script>alert(1)</script>演示备注' })).json();
    pack = await (await request(`/api/packages/${job.id}/review`, broker, 'POST', { revision: pack.revision, confirmed: true })).json();
    const exported = await request(`/api/packages/${job.id}/export`);
    assert.equal(exported.status, 200);
    const html = await exported.text(); assert.match(html, /模拟材料/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
    pack = await (await request(`/api/packages/${job.id}`, broker, 'PATCH', { revision: pack.revision, note: '修改后需复核' })).json();
    assert.equal(pack.status, 'draft');
    assert.equal((await request(`/api/packages/${job.id}/export`)).status, 409);
    assert.equal((await request(`/api/packages/${job.id}/review`, broker, 'POST', { revision: pack.revision, confirmed: true })).status, 200);
    await submit(await draft(), 'http-new-version');
    assert.equal((await request(`/api/packages/${job.id}/export`)).status, 409);
  } finally { await app.close(); }
});

test('HTTP 抽取接口绑定 schema 版本，并返回待确认与原文依据', async () => {
  const app = await start();
  try {
    const headers = { origin: app.origin, 'content-type': 'application/json' };
    for (const actor of ['__proto__', 'constructor', 'toString', [], {}, '']) {
      const denied = await fetch(app.origin + '/api/demo/session', { method: 'POST', headers, body: JSON.stringify({ actor }) });
      assert.equal(denied.status, 422);
      assert.equal(denied.headers.get('set-cookie'), null);
    }
    const session = await fetch(app.origin + '/api/demo/session', { method: 'POST', headers, body: JSON.stringify({ actor: 'broker' }) });
    headers.cookie = session.headers.get('set-cookie').split(';')[0];
    const input = { productId: 'demo-savings-01', text: '35岁，不吸烟，年缴1万美元，5年缴' };
    for (const schemaVersion of [undefined, 'old-version']) {
      const res = await fetch(app.origin + '/api/extract', { method: 'POST', headers, body: JSON.stringify({ ...input, schemaVersion }) });
      assert.equal(res.status, 409);
    }
    const res = await fetch(app.origin + '/api/extract', { method: 'POST', headers, body: JSON.stringify({ ...input, schemaVersion: '1' }) });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.requiresConfirmation, true);
    assert.equal(result.schemaVersion, '1');
    assert.equal(result.params.smoker, false);
    assert.equal(result.evidence.currency, '美元');
    assert.equal(app.store.list('job').length, 0);
  } finally { await app.close(); }
});
