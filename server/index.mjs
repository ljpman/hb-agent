import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { Store } from './store.mjs';
import { Service } from './service.mjs';
import { createAdapterRegistry } from './adapters/registry.mjs';
import { createDifyClient } from './dify/dify-client.mjs';
import { product, demoActors, demoKnowledge, statusLabels, followupStages } from './catalog.mjs';
import { AppError, check } from './errors.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function rawBody(req) {
  check(req.headers['content-type']?.split(';')[0] === 'application/json', 415, 'JSON_REQUIRED', '请求需使用 JSON。');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; check(size <= 24000, 413, 'BODY_TOO_LARGE', '输入过长。'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
function parseBody(text) {
  try { const parsed = JSON.parse(text); check(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 400, 'JSON_INVALID', '请求格式不正确。'); return parsed; }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError(400, 'JSON_INVALID', '请求格式不正确。'); }
}
async function body(req) { return parseBody(await rawBody(req)); }
function exportedPackage(pack, client) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>演示讲解包</title><style>body{font:16px/1.8 system-ui,sans-serif;color:#193b35;max-width:800px;margin:48px auto;padding:24px}h1{font-size:28px}h2{font-size:20px;margin-top:30px}aside{background:#fbf1df;padding:16px}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}small{color:#576961}pre{white-space:pre-wrap;font:inherit}</style><h1>方案讲解包 · 演示版</h1><aside>模拟材料，不构成保司计划书或投保建议。当前没有真实产品利益数据。以下参数来源于模拟参数确认单第 1 页。</aside><p>${escapeHtml(client.name)}（演示客户） · 方案 V${pack.job.version} · 讲解包修订 ${pack.revision}</p><table><tbody>${pack.facts.map(f => `<tr><th>${escapeHtml(f.label)}</th><td>${escapeHtml(f.value)}</td></tr>`).join('')}</tbody></table>${pack.sections.map(s => `<h2>${escapeHtml(s.title)}</h2><p>${escapeHtml(s.text)}</p>`).join('')}<h2>沟通备注</h2><pre>${escapeHtml(pack.note)}</pre><small>本次复核：${escapeHtml(pack.reviewedBy)} · ${escapeHtml(pack.reviewedAt)}<br>该导出为独立版本。后续方案变化时应重新核对。</small></html>`;
}

export function createApp({ database = process.env.HB_DATABASE || resolve(root, 'data/prototype.sqlite'), tick = true, serviceOptions = {} } = {}) {
  check(process.env.NODE_ENV !== 'production', 500, 'DEMO_ONLY', '当前是本地演示应用，禁止以 production 模式启动。');
  check(!process.env.DIFY_API_URL && !process.env.DIFY_API_KEY, 500, 'DIFY_OFFLINE_ONLY', 'M2a-2 仅支持离线模式；真实 Dify 配置属于 M2b。');
  const registry = createAdapterRegistry({ pythonAdapterUrl: process.env.HB_PYTHON_ADAPTER_URL || null, strict: process.env.NODE_ENV === 'production' });
  const dify = createDifyClient({ apiUrl: process.env.DIFY_API_URL || null, apiKey: process.env.DIFY_API_KEY || null });
  const store = new Store(database); const service = new Service(store, { registry, dify, ...serviceOptions });
  const interval = tick ? setInterval(() => service.tick().catch(() => {}), 300) : null;
  interval?.unref();
  const server = createServer(async (req, res) => {
    const port = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const host = req.headers.host;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      check(allowedHosts.includes(host), 403, 'LOCAL_ONLY', '该演示仅允许本机访问。');
      const url = new URL(req.url, `http://${host}`);
      const path = url.pathname;
      // Service-to-service routes use signed capabilities, never demo cookies.
      // Exact request target is signed, including a query string if supplied.
      if (path.startsWith('/api/dify/')) {
        const auditMatch = path.match(/^\/api\/dify\/tool\/compliance-audit\/([\w-]+)$/);
        check((req.method === 'POST' && ['/api/dify/tool/compliance-audit', '/api/dify/tool/progress', '/api/dify/callback'].includes(path)) || (req.method === 'GET' && auditMatch), 404, 'NOT_FOUND', '接口不存在。');
        const raw = req.method === 'POST' ? await rawBody(req) : '';
        const gateway = service.difyGateway;
        const context = gateway.authenticate(req.method, req.url, req.headers, raw);
        if (auditMatch) return json(200, gateway.readAudit(context, auditMatch[1]));
        const input = parseBody(raw);
        if (path === '/api/dify/tool/compliance-audit') return json(201, gateway.compliance(context, input));
        if (path === '/api/dify/tool/progress') return json(200, gateway.progress(context, input));
        return json(200, gateway.callback(context, input));
      }
      if (!['GET', 'HEAD'].includes(req.method)) check(req.headers.origin === `http://${host}`, 403, 'ORIGIN_INVALID', '请求来源不正确。');
      if (path === '/api/demo/session' && req.method === 'POST') {
        const input = await body(req); const actor = demoActors[input.actor || 'broker'];
        check(actor, 422, 'ACTOR_INVALID', '演示身份不存在。');
        const token = randomBytes(32).toString('hex');
        store.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
        store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(token), JSON.stringify(actor), Date.now() + 12 * 3600000);
        res.setHeader('Set-Cookie', `hb_demo=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
        return json(200, { actor, isMock: true });
      }
      if (path.startsWith('/api/')) {
        const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('hb_demo='))?.slice(8);
        const session = token && store.db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(sha(token), Date.now());
        check(session, 401, 'AUTH_REQUIRED', '请进入演示工作台。');
        const actor = JSON.parse(session.actor);
        const match = pattern => path.match(pattern);
        if (path === '/api/bootstrap' && req.method === 'GET') return json(200, {
          actor, isMock: true, product, clients: store.list('client', actor), jobs: store.list('job', actor),
          events: store.list('event', actor).slice(0, 60), messages: store.list('message', actor).slice(0, 50).reverse(),
          knowledge: demoKnowledge, statusLabels, followupStages,
          integrations: { python: service.registry.status().python, dify: service.dify.status().dify, im: 'prototype-only' }
        });
        if (path === '/api/products' && req.method === 'GET') return json(200, { products: [product] });
        if (path === `/api/products/${product.id}/schema` && req.method === 'GET') return json(200, product);
        if (path === '/api/proposal-drafts' && req.method === 'POST') return json(201, service.createDraft(actor, await body(req)));
        if (path === '/api/proposals' && req.method === 'POST') return json(202, service.createJob(actor, await body(req), req.headers['idempotency-key']));
        if (path === '/api/proposals' && req.method === 'GET') return json(200, { jobs: store.list('job', actor) });
        if (path === '/api/extract' && req.method === 'POST') { const input = await body(req); check(input.productId === product.id, 422, 'PRODUCT_INVALID', '请选择演示产品。'); return json(200, await service.extract(input.text)); }
        if (path === '/api/assistant' && req.method === 'POST') { const input = await body(req); return json(200, await service.assistant(actor, input.text, input.clientId)); }
        let m;
        if ((m = match(/^\/api\/clients\/([\w-]+)$/))) {
          if (req.method === 'PATCH') return json(200, service.updateClient(actor, m[1], await body(req)));
          if (req.method === 'GET') return json(200, { client: service.get(actor, 'client', m[1]), jobs: store.list('job', actor).filter(j => j.clientId === m[1]), events: store.list('event', actor).filter(e => e.clientId === m[1]) });
        }
        if ((m = match(/^\/api\/proposals\/([\w-]+)\/download$/)) && req.method === 'GET') {
          const bytes = service.readPdf(actor, m[1]); res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="DEMO-${m[1]}.pdf"` }); res.end(bytes); return;
        }
        if ((m = match(/^\/api\/proposals\/([\w-]+)\/resolve$/)) && req.method === 'POST') return json(200, service.resolve(actor, m[1], await body(req)));
        if ((m = match(/^\/api\/proposals\/([\w-]+)$/)) && req.method === 'GET') return json(200, service.get(actor, 'job', m[1]));
        if ((m = match(/^\/api\/packages\/([\w-]+)\/review$/)) && req.method === 'POST') return json(200, service.savePackage(actor, m[1], await body(req), true));
        if ((m = match(/^\/api\/packages\/([\w-]+)\/export$/)) && req.method === 'GET') {
          const pack = service.package(actor, m[1]);
          check(pack.status === 'reviewed' && !pack.outdated, 409, 'REVIEW_REQUIRED', '请先复核最新版本讲解包。');
          const client = service.get(actor, 'client', pack.clientId);
          const document = exportedPackage(pack, client);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="DEMO-brief-V${pack.job.version}.html"`, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }); res.end(document); return;
        }
        if ((m = match(/^\/api\/packages\/([\w-]+)$/))) {
          if (req.method === 'GET') return json(200, service.package(actor, m[1]));
          if (req.method === 'PATCH') return json(200, service.savePackage(actor, m[1], await body(req)));
        }
        throw new AppError(404, 'NOT_FOUND', '接口不存在。');
      }
      const staticFiles = { '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'], '/styles.css': ['public/styles.css', 'text/css'], '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'] };
      check(req.method === 'GET' || req.method === 'HEAD', 405, 'METHOD_NOT_ALLOWED', '不支持该方法。');
      const entry = staticFiles[path]; check(entry, 404, 'NOT_FOUND', '页面不存在。');
      const contents = await readFile(resolve(root, entry[0]));
      res.writeHead(200, { 'Content-Type': `${entry[1]}; charset=utf-8` }); res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (!res.headersSent) json(error.status || 500, { error: { code: error.code || 'INTERNAL_ERROR', message: error instanceof AppError ? error.message : '服务暂时不可用，请重试。', details: error instanceof AppError ? error.details : undefined } });
      else res.end();
    }
  });
  async function close() {
    if (interval) clearInterval(interval);
    await new Promise(resolveClose => server.close(resolveClose));
    while (service.busy) await new Promise(r => setTimeout(r, 20));
    store.close();
  }
  return { server, service, store, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createApp(); const port = Number(process.env.PORT || 4318);
  app.server.listen(port, '127.0.0.1', () => console.log(`HB Agent demonstration: http://127.0.0.1:${app.server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
