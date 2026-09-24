import { randomUUID, createHash } from 'node:crypto';
import { product, demoActors, scenarios, followupStages, statusLabels } from './catalog.mjs';
import { check, AppError } from './errors.mjs';
import { createMockPdf } from './pdf.mjs';
import { createAdapterRegistry } from './adapters/registry.mjs';
import { createDifyClient } from './dify/dify-client.mjs';
import { DifyGateway, saveCompliance } from './dify/gateway.mjs';
import { LocalFallbackDifyClient } from './dify/local-fallback.mjs';
import { extractParameters, parseEvidenceValue } from './dify/parameter-extractor.mjs';
import { classifyIntent, isKnownIntent, isPolicyClaimsProgress } from './dify/intent-router.mjs';
import { evaluateCompliance, COMPLIANCE_RULES, hasUnverifiedNumber } from './dify/compliance.mjs';
import { createPdfVerifier, VERIFY } from './verify/pdf-verifier.mjs';

const id = prefix => `${prefix}-${randomUUID()}`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const confirmationHash = (snapshot, params) => hash({ productId: snapshot.id, productVersion: snapshot.version,
  schemaVersion: snapshot.schemaVersion, productSnapshotHash: hash(snapshot), params });
const iso = time => new Date(time).toISOString();
const string = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const chineseDigits = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const chineseDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || iso(time).slice(0, 10) !== value) return null;
  const [year, month, day] = value.split('-').map(part => String(Number(part)));
  const chineseNumber = number => {
    if (number < 10) return chineseDigits[number];
    if (number === 10) return '十';
    if (number < 20) return `十${chineseDigits[number % 10]}`;
    const tens = Math.floor(number / 10), remainder = number % 10;
    return `${chineseDigits[tens]}十${remainder ? chineseDigits[remainder] : ''}`;
  };
  return `${[...year].map(digit => chineseDigits[Number(digit)]).join('')}年${chineseNumber(Number(month))}月${chineseNumber(Number(day))}日`;
};
const scope = (actor, record) => record && record.tenantId === actor.tenantId && (actor.role === 'operator' || record.ownerId === actor.id);
// credentialRef is a backend-managed account identity, never a password. Jobs
// without a mapped reference share a conservative global execution slot.
const executionResource = job => hash({ credentialRef: job.credentialRef || 'unconfigured-python-account' });
export class Service {
  constructor(store, { now = Date.now, pdf = createMockPdf, stepMs = 1500, registry = createAdapterRegistry(), dify = createDifyClient(), difyExtractEnabled = false, leaseMs = 30000, verifier = createPdfVerifier() } = {}) {
    check(Number.isSafeInteger(leaseMs) && leaseMs >= 30 && leaseMs <= 3600000, 500, 'LEASE_CONFIG_INVALID', '任务租约时长配置无效。');
    check(typeof difyExtractEnabled === 'boolean', 500, 'DIFY_EXTRACT_MODE_INVALID', 'Dify 参数抽取开关配置无效。');
    this.workerId = id('worker'); this.leaseMs = leaseMs; this.verifier = verifier;
    this.store = store; this.now = now; this.pdf = pdf; this.stepMs = stepMs; this.registry = registry; this.dify = dify;
    this.difyExtractEnabled = difyExtractEnabled; this.busy = false;
    this.seed(); this.recover(); this.difyGateway = new DifyGateway(this);
  }
  seed() {
    const samples = [
      { id: 'client-chen', name: '陈先生', initials: '陈', goal: '为孩子准备教育金，先了解缴费安排', stage: '方案准备', nextAction: '准备一份方案，确认缴费年期', days: 0, tag: '教育规划', color: 'sage' },
      { id: 'client-lam', name: '林女士', initials: '林', goal: '关注长期储蓄和资金使用安排', stage: '需求沟通', nextAction: '确认年度预算与流动性需求', days: 1, tag: '长期储蓄', color: 'sand' },
      { id: 'client-wong', name: '黄先生', initials: '黄', goal: '了解方案说明，整理待确认问题', stage: '待客户反馈', nextAction: '跟进客户的问题清单', days: 2, tag: '家庭规划', color: 'blue' }
    ];
    for (const sample of samples) {
      if (!this.store.get('client', sample.id)) this.store.put('client', {
        ...sample, tenantId: demoActors.broker.tenantId, ownerId: demoActors.broker.id, isMock: true,
        notes: '演示客户，无真实个人资料。', nextAt: iso(this.now() + sample.days * 86400000).slice(0, 10),
        createdAt: iso(this.now()), updatedAt: iso(this.now()), revision: 1
      });
    }
  }
  get(actor, kind, recordId) {
    const record = this.store.get(kind, recordId);
    check(scope(actor, record), 404, 'NOT_FOUND', '记录不存在或你没有访问权限。');
    return record;
  }
  audit(actor, type, subjectId, detail, clientId = null) {
    return this.store.put('event', { id: id('event'), tenantId: actor.tenantId, ownerId: actor.id,
      actorName: actor.name, type, subjectId, clientId, detail, createdAt: iso(this.now()) });
  }
  auditDifyFailure(actor, capability) {
    this.audit(actor, 'dify.call-failed', capability, 'Dify 调用失败；已省略上游错误详情。');
  }
  safeDifyError(error) {
    if (error instanceof AppError && ['DIFY_UNAVAILABLE', 'DIFY_APP_NOT_CONFIGURED', 'DIFY_RESULT_INVALID', 'DIFY_USER_REQUIRED'].includes(error.code)) return error;
    return new AppError(502, 'DIFY_UNAVAILABLE', 'Dify 暂不可用，未获得回复，请稍后重试或转人工处理。');
  }
  eventForJob(job, type, detail) {
    this.audit({ id: job.ownerId, tenantId: job.tenantId, name: job.isMock ? '模拟执行服务' : '计划书执行服务' }, type, job.id, detail, job.clientId);
  }
  normalizeFieldValue(field, value) {
    if (value === null || value === undefined || value === '') return { error: `请填写${field.label}` };
    if (field.type === 'integer') {
      const number = Number(value);
      if ((typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) || !Number.isInteger(number) || number < field.min || number > field.max) {
        return { error: `演示年龄范围为 ${field.min}–${field.max} 岁` };
      }
      return { value: number };
    }
    if (field.type === 'boolean') return typeof value === 'boolean' ? { value } : { error: '请选择吸烟状态' };
    if (field.type === 'enum') return field.options.includes(String(value)) ? { value: String(value) } : { error: `请选择有效的${field.label}` };
    const raw = String(value);
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(raw)) return { error: '请输入最多两位小数的金额' };
    const centsOf = amount => {
      const [whole, fraction = ''] = amount.split('.');
      return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    };
    const cents = centsOf(raw);
    if (cents < centsOf(field.min) || cents > centsOf(field.max)) return { error: `演示${field.label}范围为 ${field.min}–${field.max}` };
    return { value: `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}` };
  }
  validate(params) {
    check(params && typeof params === 'object' && !Array.isArray(params), 422, 'PARAM_INVALID', '请填写参数。');
    const errors = {}; const normalized = {};
    for (const field of product.fields) {
      const result = this.normalizeFieldValue(field, params[field.key]);
      if (result.error) errors[field.key] = result.error;
      else normalized[field.key] = result.value;
    }
    check(Object.keys(errors).length === 0, 422, 'PARAM_INVALID', '请补充或修改标出的参数。', errors);
    return normalized;
  }
  productAvailability(actor, productId = product.id) {
    check(productId === product.id, 404, 'PRODUCT_INVALID', '产品不存在。');
    const record = this.store.get('product-control', hash({ tenantId: actor.tenantId, productId }));
    return record ? { productId, paused: record.paused, revision: record.revision, reason: record.reason, updatedAt: record.updatedAt }
      : { productId, paused: false, revision: 0, reason: '', updatedAt: null };
  }
  assertProductAvailable(actor, productId = product.id) {
    check(!this.productAvailability(actor, productId).paused, 409, 'PRODUCT_PAUSED', '该产品已暂停，请联系运营核实后再提交。');
  }
  setProductAvailability(actor, productId, input) {
    check(actor.role === 'operator', 403, 'ROLE_REQUIRED', '只有运营身份可以暂停或恢复产品。');
    check(typeof input.paused === 'boolean' && typeof input.reason === 'string' && input.reason.trim().length >= 2 && input.reason.length <= 300,
      422, 'CONTROL_INVALID', '请选择产品状态并填写 2–300 字处理原因。');
    this.checkAssistantInput(input.reason);
    return this.store.transaction(() => {
      const current = this.productAvailability(actor, productId);
      check(current.revision === input.revision, 409, 'VERSION_CONFLICT', '产品状态已更新，请刷新后处理。');
      this.store.put('product-control', { id: hash({ tenantId: actor.tenantId, productId }), tenantId: actor.tenantId, ownerId: actor.id,
        productId, paused: input.paused, reason: input.reason.trim(), revision: current.revision + 1, updatedAt: iso(this.now()) });
      this.audit(actor, input.paused ? 'product.paused' : 'product.resumed', productId, input.reason.trim());
      return this.productAvailability(actor, productId);
    });
  }
  createDraft(actor, input) {
    const client = this.get(actor, 'client', input.clientId);
    check(actor.role === 'broker', 403, 'ROLE_REQUIRED', '请使用经纪身份创建方案。');
    check(input.productId === product.id && input.schemaVersion === product.schemaVersion, 409, 'SCHEMA_CHANGED', '产品字段版本已变化，请重新打开表单。');
    this.assertProductAvailable(actor, input.productId);
    const params = this.validate(input.params);
    const scenario = input.scenario || 'success';
    check(scenarios.includes(scenario), 422, 'SCENARIO_INVALID', '演示场景不正确。');
    const productSnapshot = structuredClone(product);
    const draft = { id: id('draft'), tenantId: actor.tenantId, ownerId: actor.id, clientId: client.id,
      productId: product.id, productVersion: product.version, schemaVersion: product.schemaVersion,
      productSnapshot, productSnapshotHash: hash(productSnapshot),
      params, paramsHash: confirmationHash(productSnapshot, params),
      revision: 1, scenario, createdAt: iso(this.now()), expiresAt: iso(this.now() + 30 * 60000) };
    this.store.put('draft', draft); return draft;
  }
  createJob(actor, input, key) {
    check(actor.role === 'broker', 403, 'ROLE_REQUIRED', '请使用经纪身份提交方案。');
    check(typeof key === 'string' && /^[\w-]{8,100}$/.test(key), 400, 'IDEMPOTENCY_REQUIRED', '提交需要有效的幂等标识。');
    const requestHash = hash({ draftId: input.draftId, revision: input.revision, paramsHash: input.paramsHash });
    return this.store.transaction(() => {
      const previous = this.store.db.prepare('SELECT * FROM idempotency WHERE tenant=? AND owner=? AND key=?').get(actor.tenantId, actor.id, key);
      if (previous) {
        check(previous.request_hash === requestHash, 409, 'IDEMPOTENCY_CONFLICT', '同一提交标识不能用于不同参数。');
        return this.get(actor, 'job', previous.job_id);
      }
      const draft = this.get(actor, 'draft', input.draftId);
      check(draft.revision === input.revision && draft.paramsHash === input.paramsHash, 409, 'CONFIRMATION_CHANGED', '参数已变化，请重新确认。');
      check(Date.parse(draft.expiresAt) > this.now(), 409, 'CONFIRMATION_EXPIRED', '确认页已过期，请重新检查参数。');
      check(draft.productSnapshot && draft.productSnapshotHash, 409, 'SCHEMA_CHANGED', '确认记录缺少完整产品版本，请重新打开表单。');
      check(draft.productSnapshotHash === hash(draft.productSnapshot) && draft.paramsHash === confirmationHash(draft.productSnapshot, draft.params),
        409, 'CONFIRMATION_CHANGED', '确认快照完整性核对失败，请重新确认。');
      check(draft.productId === product.id && draft.productVersion === product.version && draft.schemaVersion === product.schemaVersion &&
        draft.productSnapshotHash === hash(product), 409, 'SCHEMA_CHANGED', '产品版本或字段规则已变化，请重新确认。');
      check(input.confirmed === true, 422, 'CONFIRMATION_REQUIRED', '请先勾选参数确认。');
      const already = this.store.list('job', actor).find(job => job.draftId === draft.id);
      if (already) {
        this.store.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)').run(actor.tenantId, actor.id, key, requestHash, already.id);
        return already;
      }
      this.assertProductAvailable(actor, draft.productId);
      this.get(actor, 'client', draft.clientId);
      // Resolve which executor runs this product; refuses a real product that has
      // no configured adapter (no silent fallback to mock). isMock is derived here.
      const exec = this.registry.resolveForProduct(product);
      const siblings = this.store.list('job', actor).filter(job => job.clientId === draft.clientId);
      const job = {
        id: id('job'), tenantId: actor.tenantId, ownerId: actor.id, clientId: draft.clientId, draftId: draft.id,
        params: draft.params, paramsHash: draft.paramsHash, productId: draft.productId, productVersion: draft.productVersion,
        productSnapshot: structuredClone(draft.productSnapshot), productSnapshotHash: draft.productSnapshotHash,
        version: siblings.length + 1, schemaVersion: draft.schemaVersion, scenario: draft.scenario,
        execution: structuredClone(draft.productSnapshot.execution ?? { mode: 'mock' }),
        status: 'queued', isMock: exec.isMock, createdAt: iso(this.now()), updatedAt: iso(this.now()),
        nextAt: this.now() + this.stepMs, confirmedAt: iso(this.now()), confirmedBy: actor.name,
        history: [{ status: 'queued', at: iso(this.now()), text: '经纪已确认参数，模拟任务已接受' }]
      };
      this.store.put('job', job);
      this.store.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)').run(actor.tenantId, actor.id, key, requestHash, job.id);
      this.audit(actor, 'proposal.confirmed', job.id, `确认并创建方案 V${job.version}`, job.clientId);
      return job;
    });
  }
  persistTransition(job, status, text, error = null) {
    job.status = status; job.updatedAt = iso(this.now()); job.nextAt = this.now() + this.stepMs; job.error = error;
    job.history.push({ status, at: job.updatedAt, text }); this.store.put('job', job);
    this.eventForJob(job, `proposal.${status}`, text);
  }
  transition(job, status, text, error = null, patch = {}) {
    // State and its audit evidence must either both persist or both roll back.
    // Work on a copy so a failed transaction cannot leave the caller mutated.
    const next = { ...structuredClone(job), ...patch };
    this.store.transaction(() => this.persistTransition(next, status, text, error));
    Object.assign(job, next);
  }
  recover() {
    // Only local, side-effect-free mock work can be safely resumed automatically.
    this.store.transaction(() => {
      for (const job of this.store.list('job')) {
        const lease = this.store.lease(job.id);
        if (lease && lease.expires > this.now()) continue;
        if (!job.isMock && ['running', 'validating'].includes(job.status)) this.persistTransition(job, 'awaiting_manual', '执行中断，需先核实门户结果', 'RESULT_UNKNOWN');
        else if (job.isMock && ['queued', 'running', 'validating'].includes(job.status)) { job.nextAt = this.now(); this.store.put('job', job); }
        if (lease) this.store.releaseLease(lease);
      }
    });
  }
  claimWork() {
    return this.store.transaction(() => {
      const now = this.now();
      for (const job of this.store.list('job').reverse()) {
        if (!['queued', 'running', 'validating'].includes(job.status) || job.nextAt > now) continue;
        const previous = this.store.lease(job.id);
        if (previous && previous.expires > now) continue;
        if (job.status === 'queued' && job.productId === product.id && this.productAvailability(job, job.productId).paused) {
          this.persistTransition(job, 'awaiting_manual', '产品已暂停，排队任务停止执行，等待运营核实', 'PRODUCT_PAUSED');
          if (previous) this.store.releaseLease(previous);
          continue;
        }
        // An expired real execution, or a durable submission with no outcome,
        // is uncertain. Never submit it again, even without a process restart.
        if (!job.isMock && ((previous && ['running', 'validating'].includes(job.status)) ||
            (job.status === 'running' && job.executionAttempt))) {
          this.persistTransition(job, 'awaiting_manual', '执行租约失效或结果未落库，需核实门户结果', 'RESULT_UNKNOWN');
          if (previous) this.store.releaseLease(previous);
          continue;
        }
        if (!job.isMock && ['queued', 'running'].includes(job.status)) {
          const resource = this.store.db.prepare('SELECT job_id FROM execution_resources WHERE resource_key=?').get(executionResource(job));
          if (resource && resource.job_id !== job.id) continue;
        }
        const lease = { job_id: job.id, owner: this.workerId, token: randomUUID(), expires: now + this.leaseMs, heartbeat: now };
        this.store.db.prepare('INSERT OR REPLACE INTO job_leases VALUES(?,?,?,?,?)').run(lease.job_id, lease.owner, lease.token, lease.expires, lease.heartbeat);
        if (!job.isMock && job.status === 'running') {
          this.store.db.prepare('INSERT OR IGNORE INTO execution_resources VALUES(?,?,?)').run(executionResource(job), job.id, now);
          job.executionAttempt = { id: `${job.id}-attempt-${randomUUID()}`, startedAt: iso(now) };
          this.store.put('job', job);
          this.eventForJob(job, 'proposal.execution-started', '执行尝试已持久记录，结果未知时不自动重提');
        }
        return { job, lease };
      }
      return null;
    });
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    let claimed, heartbeat;
    try {
      claimed = this.claimWork();
      if (!claimed) return;
      const { job, lease } = claimed;
      const controller = new AbortController();
      let lost = false;
      heartbeat = setInterval(() => {
        try { if (this.store.renewLease(lease, this.now(), this.leaseMs)) return; } catch { /* Lost storage access means no authority to deliver. */ }
        lost = true; controller.abort();
      }, Math.floor(this.leaseMs / 3));
      heartbeat.unref();
      const adapter = this.registry.resolve(job);
      // Guard against configuration drift: the adapter that runs a job must agree
      // with the job's recorded isMock, so a real job is never served by the mock.
      let outcome;
      const snapshot = JSON.stringify(job);
      try {
        outcome = !adapter || adapter.isMock !== job.isMock
          ? { kind: 'transition', status: 'awaiting_manual', text: '执行器配置与任务标识不一致，已暂停', error: 'ADAPTER_MISMATCH' }
          : await adapter.advance(structuredClone(job), { pdf: this.pdf, signal: controller.signal });
      }
      catch { outcome = { kind: 'transition', status: 'awaiting_manual', text: '执行服务异常，结果未知，转人工核实', error: 'RESULT_UNKNOWN' }; }
      // The Service, not the adapter, verifies a real candidate against the
      // confirmed snapshot. A verifier failure is unknown, never a pass.
      let verification = null;
      if (outcome?.kind === 'candidate' && !job.isMock && job.status === 'validating') {
        try { verification = await this.verifier.verify({ bytes: outcome.bytes, job: structuredClone(job) }); }
        catch { verification = null; }
      }
      this.store.transaction(() => {
        const current = this.store.lease(job.id);
        if (lost || !current || current.token !== lease.token || current.owner !== lease.owner || current.expires <= this.now()) return;
        if (JSON.stringify(this.store.get('job', job.id)) !== snapshot) return;
        this.applyOutcome(job, outcome, verification);
        // Contract rejections mean the request never executed; a verified file
        // means the portal work finished. Unknown, interrupted, unverifiable or
        // mismatched results retain the account hold until an operator checks.
        const release = job.isMock ? null
          : job.status === 'failed' && ['PARAM_INVALID', 'PRODUCT_UNAVAILABLE'].includes(job.error) ? '执行服务明确拒绝参数或产品，释放账号；修改后须重新确认'
          : job.status === 'succeeded' ? '文件已通过确定性核验，门户操作完成，释放账号' : null;
        if (release && this.store.db.prepare('DELETE FROM execution_resources WHERE job_id=?').run(job.id).changes) {
          this.eventForJob(job, 'execution.account-released', release);
        }
      });
    } finally {
      clearInterval(heartbeat);
      try { if (claimed) this.store.releaseLease(claimed.lease); }
      finally { this.busy = false; }
    }
  }
  applyOutcome(job, outcome, verification = null) {
    if (!outcome) return;
    const allowed = { queued: ['running', 'awaiting_manual', 'failed'], running: ['validating', 'awaiting_manual', 'failed'], validating: ['awaiting_manual', 'failed'] };
    check(Object.hasOwn(allowed, job.status), 409, 'STATE_CONFLICT', '已结束的任务不能接受执行结果。');
    if (job.status === 'queued' && job.productId === product.id && this.productAvailability(job, job.productId).paused) {
      return this.transition(job, 'awaiting_manual', '产品已暂停，排队任务停止执行，等待运营核实', 'PRODUCT_PAUSED');
    }
    if (outcome.kind === 'transition' && outcome.error === 'PORTAL_CHANGED' && job.productId === product.id) {
      const actor = { id: job.ownerId, tenantId: job.tenantId, name: '计划书执行服务', role: 'operator' };
      const current = this.productAvailability(actor, job.productId);
      if (!current.paused) this.setProductAvailability(actor, job.productId, { paused: true, revision: current.revision, reason: '执行器检测到门户变化，暂停新任务，需运营核实后恢复' });
    }
    const reject = () => this.transition(job, 'awaiting_manual', '执行结果不符合当前交付契约，已阻止交付', 'RESULT_UNKNOWN');
    if (outcome.kind === 'candidate') return this.applyVerifiedCandidate(job, outcome, verification, reject);
    if (outcome.kind === 'artifact') {
      // Demonstration path only. Real files arrive as `candidate` and pass the
      // Service's deterministic verifier; an adapter cannot self-approve.
      if (!job.isMock || job.status !== 'validating' || !Buffer.isBuffer(outcome.bytes) ||
          outcome.bytes.subarray(0, 5).toString() !== '%PDF-') return reject();
      const next = structuredClone(job);
      this.store.transaction(() => {
        this.store.artifact(job.id, outcome.bytes); next.artifactHash = createHash('sha256').update(outcome.bytes).digest('hex');
        this.persistTransition(next, 'succeeded', outcome.text);
      });
      Object.assign(job, next);
      return;
    }
    if (outcome.kind !== 'transition' || !allowed[job.status].includes(outcome.status) ||
        (outcome.patch && (typeof outcome.patch !== 'object' || Array.isArray(outcome.patch) ||
          Object.keys(outcome.patch).some(key => !['source', 'validation', 'artifactRef'].includes(key))))) return reject();
    this.transition(job, outcome.status, outcome.text, outcome.error ?? null, outcome.patch);
  }
  applyVerifiedCandidate(job, outcome, verification, reject) {
    const bytes = outcome.bytes;
    if (job.isMock || job.status !== 'validating' || !Buffer.isBuffer(bytes) || !job.artifactRef || outcome.artifactRef !== job.artifactRef ||
        !verification || !Object.values(VERIFY).includes(verification.status)) return reject();
    const fileSha256 = createHash('sha256').update(bytes).digest('hex');
    if (verification.fileSha256 !== fileSha256) return reject();
    // Evidence names each checked field and page; values read from the PDF are
    // never stored, so no unverified document number reaches brokers or chat.
    const validation = { status: verification.status, ruleSet: verification.ruleSet ?? null, problem: verification.problem ?? null, fileSha256, checkedAt: iso(this.now()),
      checks: (verification.checks ?? []).map(({ field, page, match }) => ({ field: String(field), page, match: match === true })) };
    if (verification.status === VERIFY.mismatch) return this.transition(job, 'awaiting_manual', '文件核验失败，已阻止交付', 'PDF_MISMATCH', { validation });
    if (verification.status !== VERIFY.passed || !validation.checks.length || !validation.checks.every(item => item.match)) {
      return this.transition(job, 'awaiting_manual', '无法可靠核验候选文件，转人工核对', 'RESULT_UNKNOWN', { validation });
    }
    const next = { ...structuredClone(job), validation, artifactHash: fileSha256 };
    this.store.transaction(() => {
      this.store.artifact(job.id, bytes);
      this.persistTransition(next, 'succeeded', '文件已通过确定性核验，可下载');
    });
    Object.assign(job, next);
  }
  readPdf(actor, jobId) {
    const job = this.get(actor, 'job', jobId);
    check(job.status === 'succeeded', 409, 'NOT_READY', '文件尚未通过核对。');
    const bytes = this.store.readArtifact(jobId); check(bytes, 404, 'FILE_MISSING', '文件尚不可用。');
    check(bytes.subarray(0, 5).toString() === '%PDF-' && createHash('sha256').update(bytes).digest('hex') === job.artifactHash,
      409, 'FILE_INTEGRITY', '文件完整性核对失败，请联系运营核实。');
    return bytes;
  }
  package(actor, jobId) {
    const job = this.get(actor, 'job', jobId);
    check(job.status === 'succeeded', 409, 'NOT_READY', '计划书完成后才能查看讲解包。');
    // The package template is demonstration content; real explanation packs need
    // verified official facts first, so they are not generated for real files.
    check(job.isMock, 409, 'PACKAGE_NOT_READY', '真实计划书的讲解包尚未接入，请先查看已核验的官方文件。');
    let pack = this.store.get('package', jobId);
    if (!pack) {
      pack = { id: jobId, tenantId: job.tenantId, ownerId: job.ownerId, clientId: job.clientId, revision: 1, status: 'draft', isMock: true,
        note: '先与客户确认缴费安排及资金使用需求，再逐项说明官方材料中的保障和限制。当前为演示资料，不能据此作出投保判断。',
        createdAt: iso(this.now()), updatedAt: iso(this.now()), history: [] };
      this.store.put('package', pack);
    }
    const latest = Math.max(...this.store.list('job', { id: job.ownerId, tenantId: job.tenantId }).filter(j => j.clientId === job.clientId).map(j => j.version));
    return { ...pack, outdated: job.version < latest, job, facts: (job.productSnapshot?.fields ?? product.fields).map(field => ({ key: field.key, label: field.label,
      value: field.key === 'smoker' ? job.params.smoker ? '吸烟' : '不吸烟' : String(job.params[field.key]), source: '模拟参数确认单 · 第 1 页', page: 1 })),
      sections: [
        { title: '方案概况', text: `本方案为演示储蓄计划 V${job.version}，用于说明从参数确认到生成文件的工作流程。` },
        { title: '缴费安排', text: `已确认的输入为：年缴 ${job.params.currency} ${job.params.annualPremium}，缴费 ${job.params.paymentTerm} 年。这里只复述输入，不计算利益演示。` },
        { title: '保障与限制', text: '尚未接入真实产品条款。保障责任、除外责任、保证与非保证利益和退保价值均待官方资料核实。' }
      ] };
  }
  savePackage(actor, jobId, input, review = false) {
    check(actor.role === 'broker', 403, 'ROLE_REQUIRED', '讲解包由所属经纪复核。');
    const current = this.package(actor, jobId);
    check(current.revision === input.revision, 409, 'VERSION_CONFLICT', '讲解包已更新，请刷新后重试。');
    check(!current.outdated || !review, 409, 'OUTDATED_PACKAGE', '已有更新方案，请先复核最新版本。');
    if (review) check(input.confirmed === true, 422, 'REVIEW_REQUIRED', '请确认已核对模拟材料。');
    const stored = this.store.get('package', jobId);
    if (!review) check(typeof input.note === 'string' && input.note.length <= 3000, 422, 'NOTE_INVALID', '备注需在 3000 字以内。');
    stored.history.push({ revision: stored.revision, status: stored.status, note: stored.note, at: stored.updatedAt });
    stored.revision += 1; stored.updatedAt = iso(this.now()); stored.status = review ? 'reviewed' : 'draft';
    stored.reviewedBy = review ? actor.name : null; stored.reviewedAt = review ? iso(this.now()) : null;
    if (!review) stored.note = string(input.note, 3000);
    this.store.put('package', stored);
    this.audit(actor, review ? 'package.reviewed' : 'package.updated', jobId, review ? '经纪已复核演示讲解包' : '讲解备注已修改，需重新复核', stored.clientId);
    return this.package(actor, jobId);
  }
  updateClient(actor, clientId, input) {
    const client = this.get(actor, 'client', clientId);
    check(actor.role === 'broker', 403, 'ROLE_REQUIRED', '请使用经纪身份更新跟进。');
    check(client.revision === input.revision, 409, 'VERSION_CONFLICT', '跟进记录已更新，请刷新。');
    check(followupStages.includes(input.stage), 422, 'STAGE_INVALID', '请选择跟进阶段。');
    check(/^\d{4}-\d{2}-\d{2}$/.test(input.nextAt) && Number.isFinite(Date.parse(input.nextAt)) && iso(Date.parse(input.nextAt)).slice(0, 10) === input.nextAt, 422, 'DATE_INVALID', '请输入有效跟进日期。');
    check(typeof input.nextAction === 'string' && input.nextAction.trim().length > 0 && input.nextAction.length <= 300, 422, 'ACTION_REQUIRED', '请填写下一步动作，最多 300 字。');
    client.stage = input.stage; client.nextAt = input.nextAt; client.nextAction = string(input.nextAction, 300); client.notes = string(input.notes, 2000);
    client.updatedAt = iso(this.now()); client.revision += 1;
    this.store.put('client', client); this.audit(actor, 'client.followup', client.id, '经纪更新了内部跟进记录', client.id); return client;
  }
  resolve(actor, jobId, input) {
    check(actor.role === 'operator', 403, 'ROLE_REQUIRED', '只有运营身份可以处理人工队列。');
    return this.store.transaction(() => {
      const job = this.get(actor, 'job', jobId);
      check(job.status === 'awaiting_manual', 409, 'STATE_CONFLICT', '该任务当前不在人工队列。');
      check(['retry_mock', 'close'].includes(input.action), 422, 'ACTION_INVALID', '请选择有效操作。');
      check(string(input.note).length >= 2, 422, 'NOTE_REQUIRED', '请填写处理说明。');
      const resource = this.store.db.prepare('SELECT resource_key FROM execution_resources WHERE job_id=?').get(job.id);
      if (resource) {
        check(input.action === 'close' && input.portalChecked === true, 409, 'PORTAL_CHECK_REQUIRED', '请先人工核实门户操作已结束并确认结果，再关闭任务释放账号。');
        const lease = this.store.lease(job.id);
        check(!lease || lease.expires <= this.now(), 409, 'EXECUTION_ACTIVE', '本地执行仍持有有效租约，请等待执行结束。');
      }
      if (input.action === 'retry_mock') {
        this.assertProductAvailable(actor, job.productId);
        check(job.isMock, 409, 'MOCK_ONLY', '该操作只适用于模拟任务。');
        check(job.error !== 'PDF_MISMATCH', 409, 'MISMATCH_BLOCKED', '文件错配任务不能直接重试，请关闭并重新确认参数。');
        job.scenario = 'success'; this.transition(job, 'queued', '运营已处理模拟登录问题，重新排队');
      } else this.transition(job, 'failed', '运营已关闭任务，请经纪重新核对后新建');
      if (resource) {
        this.store.db.prepare('DELETE FROM execution_resources WHERE resource_key=? AND job_id=?').run(resource.resource_key, job.id);
        this.audit(actor, 'execution.account-released', job.id, '运营确认门户操作已结束并核实结果，释放执行账号', job.clientId);
      }
      this.audit(actor, 'operator.resolved', job.id, string(input.note), job.clientId); return job;
    });
  }
  checkAssistantInput(text) {
    check(!evaluateCompliance({ text }).rules.includes(COMPLIANCE_RULES.SENSITIVE), 422, 'SENSITIVE_INPUT', '请移除凭据或敏感标识，仅通过受控凭据引用配置。');
  }
  mergeVerifiedExtraction(text, localResult, candidateResult) {
    const params = { ...localResult.params };
    const evidence = { ...localResult.evidence };
    const sources = Object.fromEntries(Object.keys(params).map(key => [key, 'rule']));
    const conflicts = [...localResult.conflicts];
    const unverified = new Set();
    const fields = new Map(product.fields.map(field => [field.key, field]));

    for (const [key, candidate] of Object.entries(candidateResult.params)) {
      const field = fields.get(key);
      if (!field) continue;
      const normalizedCandidate = this.normalizeFieldValue(field, candidate);
      if (Object.hasOwn(localResult.params, key)) {
        if (!normalizedCandidate.error && !Object.is(normalizedCandidate.value, localResult.params[key])) {
          delete params[key]; delete evidence[key]; delete sources[key];
          conflicts.push(`${field.label}的 Dify 候选与本地规则不一致，请经纪确认`);
          unverified.add(key);
        }
        continue;
      }

      const hasLocalConflict = localResult.conflicts.some(conflict => conflict.startsWith(field.label));
      const rawEvidence = candidateResult.evidence[key];
      const parsed = typeof rawEvidence === 'string' && text.includes(rawEvidence) && !hasLocalConflict
        ? parseEvidenceValue(key, rawEvidence, product) : undefined;
      const normalizedEvidence = parsed === undefined ? { error: '证据无法解析' } : this.normalizeFieldValue(field, parsed);
      if (normalizedCandidate.error || normalizedEvidence.error || !Object.is(normalizedCandidate.value, normalizedEvidence.value)) {
        unverified.add(key);
        continue;
      }
      params[key] = normalizedCandidate.value;
      evidence[key] = rawEvidence;
      sources[key] = 'dify-verified';
    }

    const missing = product.fields.filter(field => field.required && params[field.key] === undefined).map(field => field.key);
    return {
      ...localResult, params, evidence, sources, conflicts: [...new Set(conflicts)], missing,
      unverified: [...unverified], requiresConfirmation: true, isMock: false, engine: 'dify',
      warning: 'Dify 只提供候选；已由后端按当前字段规则及原文依据核实。无法核实的候选已留空，请经纪确认。',
    };
  }
  extract(text, actor, clientId = null) {
    // Local deterministic rules run first and remain authoritative. Dify may only
    // supplement a missing field when its exact source text parses to the same
    // schema-normalized value under the same constraints used by validate().
    check(typeof text === 'string' && text.length > 0 && text.length <= 3000, 422, 'TEXT_INVALID', '请输入 1–3000 字的需求。');
    this.checkAssistantInput(text);
    const localResult = extractParameters(text, product);
    const conversation = this.difyGateway.conversation(actor, clientId || null);
    const local = this.dify instanceof LocalFallbackDifyClient;
    const finish = result => {
      if (local) return localResult;
      check(result && result.params && typeof result.params === 'object' && !Array.isArray(result.params) &&
        result.evidence && typeof result.evidence === 'object' && !Array.isArray(result.evidence) &&
        Array.isArray(result.conflicts) && Array.isArray(result.missing), 502, 'DIFY_RESULT_INVALID', 'Dify 抽取结果不可核实，请人工处理。');
      return this.mergeVerifiedExtraction(text, localResult, result);
    };
    let pending;
    if (local || !this.difyExtractEnabled) return localResult;
    try { pending = this.dify.extractParams({ text, product, user: conversation.user }); }
    catch (error) { this.auditDifyFailure(actor, 'proposal_extract'); throw this.safeDifyError(error); }
    if (pending && typeof pending.then === 'function') {
      return pending.then(finish).catch(error => {
        if (error.code === 'DIFY_RESULT_INVALID') { this.auditDifyFailure(actor, 'proposal_extract'); throw error; }
        this.auditDifyFailure(actor, 'proposal_extract'); throw this.safeDifyError(error);
      });
    }
    try { return finish(pending); }
    catch (error) { this.auditDifyFailure(actor, 'proposal_extract'); throw this.safeDifyError(error); }
  }
  assistant(actor, text, clientId) {
    if (clientId) this.get(actor, 'client', clientId);
    check(typeof text === 'string' && text.trim().length > 0 && text.length <= 3000, 422, 'TEXT_INVALID', '请输入 1–3000 字的问题。');
    this.checkAssistantInput(text);
    const conversation = this.difyGateway.conversation(actor, clientId || null);
    const local = this.dify instanceof LocalFallbackDifyClient;
    const mapResult = (value, transform) => value && typeof value.then === 'function' ? value.then(transform) : transform(value);
    const finalize = (draft, { intent, routedBy, classifiedReply = null, semanticReview = null } = {}) => {
      const citations = Array.isArray(draft.citations) ? draft.citations : draft.engine === 'local-fallback' && draft.source ? [draft.source] : [];
      return this.store.transaction(() => {
        const difyConversationId = classifiedReply?.difyConversationId;
        if (typeof difyConversationId === 'string' && /^[\w-]{1,100}$/.test(difyConversationId)) {
          conversation.difyConversationId = difyConversationId;
          conversation.status = 'configured';
        }
        conversation.lastIntent = intent;
        conversation.lastRoutedBy = routedBy;
        conversation.lastActivityAt = iso(this.now());
        this.store.put('dify-conversation', conversation);
        const { audit: verdict, reply } = saveCompliance(this.store, actor, this.now, { originalText: text, draftReply: draft.answer, citations,
          clientId: clientId || null, semanticReview });
        const record = { id: id('message'), tenantId: actor.tenantId, ownerId: actor.id, clientId: clientId || null, text, createdAt: iso(this.now()), isMock: local,
          kind: intent === 'proposal' && draft.extraction ? 'extraction' : 'answer', engine: draft.engine || (local ? 'local-fallback' : 'backend-rules'),
          metadata: { intent, source: null, routedBy },
          compliance: { decision: verdict.decision, rules: verdict.rules, auditId: verdict.auditId, ruleVersion: verdict.ruleVersion } };
        record.isMock = draft.isMock ?? (draft.engine === 'backend-rules' || local);
        if (intent === 'proposal' && draft.extraction && verdict.decision === 'allow') {
          record.extraction = { ...draft.extraction, requiresConfirmation: true };
        }
        if (verdict.decision === 'block') {
          record.blocked = true; record.answer = reply; record.source = '合规出口拦截';
        } else {
          record.answer = reply;
          if (draft.source && (draft.sourceTrusted || (local && draft.engine === 'local-fallback'))) record.source = draft.source;
        }
        this.store.put('message', record);
        this.audit(actor, verdict.decision === 'block' ? 'compliance.blocked' : 'compliance.allowed', record.id,
          `出口审查：${verdict.decision}｜命中：${verdict.rules.join('、') || '无'}`, clientId || null);
        return record;
      });
    };

    const fixedIntentReply = (intent, routedBy, classifiedReply = null) => {
      const finish = (draft, extraction = null) => finalize({ ...draft, sourceTrusted: true, ...(extraction ? { extraction } : {}) }, {
        intent, routedBy, classifiedReply,
      });
      if (intent === 'proposal') {
        const extracted = this.extract(text, actor, clientId || null);
        return mapResult(extracted, result => finish({
          kind: 'extraction',
          answer: '已整理为待确认参数卡。请在确认页逐项核对后再确认；利益数字以保司官方计划书为准，助手不作估算。',
          engine: result.engine, isMock: result.isMock,
          source: result.engine === 'dify' ? 'Dify 候选、后端核实；参数待确认' : '本地规则提取；参数待确认',
        }, result));
      }
      if (intent === 'knowledge') return finish({
        answer: '当前没有已核验知识库，无法核实该产品事实，请以保司官方条款为准并由经纪核对。',
        engine: 'backend-rules', isMock: true, source: '演示资料边界：M3 知识库未接入',
      });
      if (intent === 'progress') {
        if (isPolicyClaimsProgress(text)) return finish({
          answer: '真实保单／理赔进度查询尚未接入。', engine: 'backend-rules', isMock: true, source: '真实进度数据源未接入',
        });
        const jobs = this.store.list('job', actor).filter(job => !clientId || job.clientId === clientId);
        const labels = [...new Set(jobs.map(job => statusLabels[job.status] || '待人工处理'))];
        const subject = clientId ? '当前客户名下' : '你名下';
        const planProgress = labels.length
            ? `${subject}计划书任务状态（演示数据）：${labels.join('、')}。`
            : `${subject}暂无可查询的计划书任务。`;
        const ambiguousCase = /案件|個案|个案/.test(text);
        return finish({
          answer: ambiguousCase
            ? `${planProgress}如果你指的是保单／理赔案件，保单／理赔进度尚未接入。`
            : planProgress,
          engine: 'backend-rules', isMock: true, source: '后端演示任务状态',
        });
      }
      if (intent === 'followup') {
        if (!clientId) return finish({
          answer: '请先在工作台选择客户，再查看该客户的跟进卡；助手不会替你写入跟进记录。',
          engine: 'backend-rules', isMock: true, source: '跟进卡未指定客户',
        });
        const client = this.get(actor, 'client', clientId);
        const proposedAction = string(client.nextAction, 300);
        const safeAction = proposedAction && !hasUnverifiedNumber(proposedAction.replace(/一份/g, '')) && evaluateCompliance({ text: proposedAction }).decision === 'allow'
          ? `下一步为「${proposedAction}」` : '当前跟进卡已记录下一步安排';
        const date = chineseDate(client.nextAt);
        return finish({
          answer: `当前客户跟进卡：${safeAction}${date ? `，日期为${date}` : ''}。如需调整，请在工作台跟进卡中修改；助手不会代为写入记录。`,
          engine: 'backend-rules', isMock: true, source: '当前客户跟进卡',
          citations: [`${client.id}:nextAction`, ...(date ? [`${client.id}:nextAt`] : [])],
        });
      }
    };

    const processGeneratedDraft = draft => {
      check(draft && typeof draft.answer === 'string' && draft.answer.trim() && draft.answer.length <= 3000,
        502, 'DIFY_RESULT_INVALID', '助手结果不可核实，请人工处理。');
      const modelIntent = draft.metadata?.intent ?? (draft.kind === 'extraction' ? 'proposal' : draft.kind);
      const routedIntent = isKnownIntent(modelIntent) ? modelIntent : null;
      if (routedIntent) return fixedIntentReply(routedIntent, 'dify', draft);

      const intent = 'unknown';
      const routedBy = draft.engine === 'local-fallback' ? 'local-fallback' : 'dify-answer';
      if (routedBy === 'local-fallback') return finalize({ ...draft, isMock: true }, { intent, routedBy });
      const blockForReviewFailure = () => {
        this.auditDifyFailure(actor, 'compliance_guard');
        return finalize(draft, { intent, routedBy, classifiedReply: draft,
          semanticReview: { decision: 'block', rules: ['semantic-review-unavailable'], reply: null } });
      };
      if (typeof this.dify.reviewCompliance !== 'function') return blockForReviewFailure();
      let review;
      try {
        review = this.dify.reviewCompliance({ draftReply: draft.answer, intent, productId: product.id,
          channel: 'app', user: conversation.user });
      } catch { return blockForReviewFailure(); }
      const receiveReview = result => {
        if (result?.rules?.includes('semantic-review-unavailable') || result?.rules?.includes('semantic-review-invalid')) {
          this.auditDifyFailure(actor, 'compliance_guard');
        }
        return finalize(draft, { intent, routedBy, classifiedReply: draft, semanticReview: result });
      };
      return review && typeof review.then === 'function' ? review.then(receiveReview, blockForReviewFailure) : receiveReview(review);
    };

    const directIntent = classifyIntent(text);
    if (directIntent) return fixedIntentReply(directIntent, 'backend-rule');
    let pending;
    try { pending = this.dify.chat({ text, product, user: conversation.user, conversation_id: conversation.difyConversationId || null }); }
    catch (error) { this.auditDifyFailure(actor, 'broker_assistant_chat'); throw this.safeDifyError(error); }
    if (pending && typeof pending.then === 'function') return pending.then(processGeneratedDraft, error => {
      this.auditDifyFailure(actor, 'broker_assistant_chat');
      throw this.safeDifyError(error);
    });
    return processGeneratedDraft(pending);
  }
}
