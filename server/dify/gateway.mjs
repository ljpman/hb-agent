import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { check } from '../errors.mjs';
import { evaluateCompliance, COMPLIANCE_VERSION } from './compliance.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const MANUAL_REPLY = '这条回复未通过合规出口检查，已转人工核对。';
const uid = prefix => `${prefix}-${randomUUID()}`;
const validId = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const textField = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 3000;
const paths = ['/api/dify/tool/compliance-audit', '/api/dify/tool/progress', '/api/dify/callback'];

// Request signatures bind the exact UTF-8 bytes, method, path, token, time and nonce.
// The only signing material handed to a future trusted tool bridge is a short-lived
// opaque capability. No long-lived key or browser token issuance endpoint exists.
export function signToolRequest(actorToken, method, path, timestamp, nonce, rawBody = '') {
  return createHmac('sha256', actorToken).update([method, path, timestamp, nonce, sha256(rawBody)].join('\n')).digest('hex');
}

export function saveCompliance(store, actor, now, { originalText, draftReply, citations = [], runId = null, clientId = null }) {
  const verdict = evaluateCompliance({ text: draftReply, citations });
  // M2a-2 has no verified official numerical source. Tool/model-supplied source
  // labels cannot authorize numbers (including premiums and coverage amounts).
  if (!citations.length && /[0-9０-９%％]|[零一二三四五六七八九十百千万亿两]+\s*(?:元|美元|港元|万|%|％)/.test(draftReply)) {
    verdict.decision = 'block';
    if (!verdict.rules.includes('unverified-number')) verdict.rules.push('unverified-number');
  }
  const reply = verdict.decision === 'block' ? MANUAL_REPLY : draftReply;
  const audit = {
    id: verdict.auditId, auditId: verdict.auditId, tenantId: actor.tenantId, ownerId: actor.id,
    runId, clientId, decision: verdict.decision, rules: verdict.rules, ruleVersion: COMPLIANCE_VERSION,
    originalHash: sha256(originalText), draftReplyHash: sha256(draftReply), replyHash: sha256(reply),
    createdAt: new Date(now()).toISOString(),
  };
  store.put('compliance-audit', audit);
  return { audit, reply };
}

export class DifyGateway {
  constructor(service) {
    this.service = service; this.store = service.store; this.now = service.now;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS dify_tokens (hash TEXT PRIMARY KEY, context TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dify_nonces (token_hash TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(token_hash,nonce));
      CREATE TABLE IF NOT EXISTS dify_events (event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, payload_hash TEXT NOT NULL);
    `);
  }
  owned(actor, kind, id) {
    const record = this.store.get(kind, id);
    check(record && record.tenantId === actor.tenantId && record.ownerId === actor.id, 404, 'NOT_FOUND', '记录不存在或无权访问。');
    return record;
  }
  conversation(actor, clientId = null) {
    check(actor?.role === 'broker' && validId(actor.id) && validId(actor.tenantId), 403, 'ACTOR_INVALID', '需要可信经纪身份。');
    if (clientId !== null) this.owned(actor, 'client', clientId);
    const id = `conversation-${sha256(JSON.stringify([actor.tenantId, actor.id, clientId]))}`;
    let record = this.store.get('dify-conversation', id);
    if (!record) record = this.store.put('dify-conversation', {
      id, tenantId: actor.tenantId, ownerId: actor.id, clientId,
      user: uid('dify-user'), conversation_id: uid('dify-conversation'), status: 'not-configured',
    });
    return record;
  }
  // Backend-only entrypoint. Called with identity from a verified session/job,
  // never with a client-supplied actor, user, conversation_id or scope list.
  issue(actor, { clientId = null, jobId = null, ttlMs = 300000 } = {}) {
    check(Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= 300000, 422, 'TTL_INVALID', '令牌有效期最多五分钟。');
    const conversation = this.conversation(actor, clientId);
    if (jobId !== null) check(this.owned(actor, 'job', jobId).clientId === clientId, 403, 'SCOPE_INVALID', '任务不属于当前客户。');
    return this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM dify_tokens WHERE expires<=?').run(this.now());
      this.store.db.prepare('DELETE FROM dify_nonces WHERE expires<=?').run(this.now());
      const run = this.store.put('dify-run', {
        id: uid('dify-run'), tenantId: actor.tenantId, ownerId: actor.id, clientId, jobId,
        conversationId: conversation.id, status: 'queued', sequence: 0, version: 0,
        isMock: true, integration: 'not-configured', createdAt: new Date(this.now()).toISOString(),
      });
      const actor_token = randomBytes(32).toString('hex');
      const expiresAt = this.now() + ttlMs;
      const context = { actor: { id: actor.id, tenantId: actor.tenantId, role: 'broker' }, runId: run.id, conversationId: conversation.id };
      this.store.db.prepare('INSERT INTO dify_tokens VALUES(?,?,?)').run(sha256(actor_token), JSON.stringify(context), expiresAt);
      return { actor_token, expiresAt, runId: run.id, user: conversation.user, conversation_id: conversation.conversation_id };
    });
  }
  authenticate(method, path, headers, rawBody) {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(headers.authorization || '')?.[1];
    check(token, 401, 'TOOL_AUTH_REQUIRED', '需要有效工具令牌。');
    const row = this.store.db.prepare('SELECT * FROM dify_tokens WHERE hash=?').get(sha256(token));
    check(row && row.expires > this.now(), 401, 'TOKEN_EXPIRED', '工具令牌失效。');
    const timestamp = headers['x-dify-timestamp'], nonce = headers['x-dify-nonce'], signature = headers['x-dify-signature'];
    check(typeof timestamp === 'string' && /^\d{13}$/.test(timestamp) && Math.abs(this.now() - Number(timestamp)) <= 60000, 401, 'TIMESTAMP_INVALID', '请求时间戳无效。');
    check(typeof nonce === 'string' && /^[\w-]{16,100}$/.test(nonce), 401, 'NONCE_INVALID', '请求 nonce 无效。');
    const expected = signToolRequest(token, method, path, timestamp, nonce, rawBody);
    check(typeof signature === 'string' && /^[a-f0-9]{64}$/.test(signature) && timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')), 401, 'SIGNATURE_INVALID', '请求签名无效。');
    check(paths.includes(path) || /^\/api\/dify\/tool\/compliance-audit\/[\w-]+$/.test(path), 403, 'SCOPE_INVALID', '工具范围无效。');
    const context = JSON.parse(row.context);
    const run = this.owned(context.actor, 'dify-run', context.runId);
    this.owned(context.actor, 'dify-conversation', context.conversationId);
    if (run.clientId) this.owned(context.actor, 'client', run.clientId);
    if (run.jobId) this.owned(context.actor, 'job', run.jobId);
    const inserted = this.store.db.prepare('INSERT OR IGNORE INTO dify_nonces VALUES(?,?,?)').run(row.hash, nonce, row.expires);
    check(inserted.changes === 1, 409, 'REPLAY', '请求已使用，请使用新的 nonce。');
    return { ...context, run };
  }
  validateInput(context, input, fields) {
    check(input && typeof input === 'object' && !Array.isArray(input), 422, 'INPUT_INVALID', '需要对象。');
    check(Object.keys(input).every(k => fields.includes(k)), 422, 'FIELD_INVALID', '包含不支持的字段。');
    check(validId(input.runId), 422, 'RUN_REQUIRED', '缺少运行编号。');
    check(input.runId === context.runId, 403, 'SCOPE_INVALID', '运行编号超出令牌范围。');
  }
  compliance(context, input) {
    this.validateInput(context, input, ['runId', 'originalText', 'draftReply']);
    check(textField(input.originalText) && textField(input.draftReply), 422, 'TEXT_REQUIRED', '缺少原文或候选回复。');
    // Caller citations/decisions are deliberately not accepted as evidence.
    return saveCompliance(this.store, context.actor, this.now, { ...input, clientId: context.run.clientId }).audit;
  }
  readAudit(context, auditId) {
    const audit = this.owned(context.actor, 'compliance-audit', auditId);
    check(audit.runId === context.runId, 403, 'SCOPE_INVALID', '审查记录超出令牌范围。');
    return audit;
  }
  progress(context, input) {
    this.validateInput(context, input, ['runId', 'caseId']);
    check(validId(input.caseId), 422, 'CASE_REQUIRED', '缺少内部客户编号。');
    check(input.caseId === context.run.clientId, 403, 'SCOPE_INVALID', '客户超出令牌范围。');
    this.owned(context.actor, 'client', input.caseId);
    return { status: 'not-configured', source: null, updatedAt: null, progress: null, message: '无保单／理赔数据来源，真实进度查询未完成。' };
  }
  callback(context, input) {
    this.validateInput(context, input, ['runId', 'eventId', 'sequence', 'version', 'status', 'originalText', 'draftReply', 'artifactRef']);
    check(validId(input.eventId) && Number.isSafeInteger(input.sequence) && input.sequence > 0 && Number.isSafeInteger(input.version) && input.version > 0, 422, 'EVENT_INVALID', '缺少有效事件编号、顺序或版本。');
    check(['running', 'succeeded', 'failed', 'awaiting_manual'].includes(input.status), 422, 'STATUS_INVALID', '状态无效。');
    if (input.status === 'succeeded') check(textField(input.originalText) && textField(input.draftReply), 422, 'TEXT_REQUIRED', '完成结果需要原文及候选回复。');
    else check(input.originalText === undefined && input.draftReply === undefined && input.artifactRef === undefined, 422, 'RESULT_INVALID', '此状态不接受回复或文件。');
    let artifactRef;
    if (input.artifactRef !== undefined) {
      check(typeof input.artifactRef === 'string' && /^artifact:job-[\w-]+$/.test(input.artifactRef), 422, 'ARTIFACT_INVALID', '只接受受控内部文件引用。');
      const jobId = input.artifactRef.slice('artifact:'.length);
      check(jobId === context.run.jobId, 403, 'SCOPE_INVALID', '文件超出当前任务范围。');
      const job = this.owned(context.actor, 'job', jobId);
      const bytes = this.service.readPdf(context.actor, jobId);
      check(bytes.subarray(0, 5).toString() === '%PDF-' && sha256(bytes) === job.artifactHash, 409, 'ARTIFACT_INVALID', '文件校验不通过。');
      artifactRef = `artifact:${job.id}`;
    }
    return this.store.transaction(() => {
      const run = this.owned(context.actor, 'dify-run', context.runId);
      const payloadHash = sha256(JSON.stringify(Object.keys(input).sort().map(k => [k, input[k]])));
      const previous = this.store.db.prepare('SELECT * FROM dify_events WHERE event_id=?').get(input.eventId);
      if (previous) {
        check(previous.run_id === run.id && previous.payload_hash === payloadHash, 409, 'EVENT_CONFLICT', '事件编号已使用。');
        return { accepted: false, reason: 'duplicate', run };
      }
      this.store.db.prepare('INSERT INTO dify_events VALUES(?,?,?)').run(input.eventId, run.id, payloadHash);
      if (input.sequence <= run.sequence || input.version < run.version) return { accepted: false, reason: 'stale', run };
      if (['succeeded', 'failed', 'awaiting_manual'].includes(run.status)) return { accepted: false, reason: 'terminal', run };
      run.sequence = input.sequence; run.version = input.version; run.status = input.status;
      if (input.status === 'succeeded') {
        const { audit, reply } = saveCompliance(this.store, context.actor, this.now, { ...input, clientId: run.clientId });
        run.compliance = audit; run.answer = reply;
        if (audit.decision === 'block') run.status = 'awaiting_manual';
        else if (artifactRef) run.artifactRef = artifactRef;
      }
      run.updatedAt = new Date(this.now()).toISOString();
      this.store.put('dify-run', run);
      return { accepted: true, run };
    });
  }
}
