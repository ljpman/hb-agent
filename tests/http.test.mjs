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

