import { randomUUID, createHash } from 'node:crypto';
import { product, demoActors, scenarios, followupStages, demoKnowledge } from './catalog.mjs';
import { check, AppError } from './errors.mjs';
import { createMockPdf } from './pdf.mjs';
import { createAdapterRegistry } from './adapters/registry.mjs';

const id = prefix => `${prefix}-${randomUUID()}`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = time => new Date(time).toISOString();
const string = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const scope = (actor, record) => record && record.tenantId === actor.tenantId && (actor.role === 'operator' || record.ownerId === actor.id);
export class Service {
  constructor(store, { now = Date.now, pdf = createMockPdf, stepMs = 1500, registry = createAdapterRegistry() } = {}) {
    this.store = store; this.now = now; this.pdf = pdf; this.stepMs = stepMs; this.registry = registry; this.busy = false;
    this.seed(); this.recover();
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
  eventForJob(job, type, detail) {
    this.audit({ id: job.ownerId, tenantId: job.tenantId, name: '模拟执行服务' }, type, job.id, detail, job.clientId);
  }
  validate(params) {
    check(params && typeof params === 'object' && !Array.isArray(params), 422, 'PARAM_INVALID', '请填写参数。');
    const errors = {}; const normalized = {};
    for (const field of product.fields) {
      const value = params[field.key];
      if (value === null || value === undefined || value === '') { errors[field.key] = `请填写${field.label}`; continue; }
      if (field.type === 'integer') {
        const number = Number(value);
        if ((typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) || !Number.isInteger(number) || number < field.min || number > field.max) errors[field.key] = `演示年龄范围为 ${field.min}–${field.max} 岁`;
        else normalized[field.key] = number;
      } else if (field.type === 'boolean') {
        if (typeof value !== 'boolean') errors[field.key] = '请选择吸烟状态';
        else normalized[field.key] = value;
      } else if (field.type === 'enum') {
        if (!field.options.includes(String(value))) errors[field.key] = `请选择有效的${field.label}`;
        else normalized[field.key] = String(value);
      } else {
        const raw = String(value);
        if (!/^\d{1,7}(\.\d{1,2})?$/.test(raw)) { errors[field.key] = '请输入最多两位小数的金额'; continue; }
        const [whole, fraction = ''] = raw.split('.');
        const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
        if (cents < 100000n || cents > 100000000n) errors[field.key] = '演示年缴保费范围为 1,000–1,000,000';
        else normalized[field.key] = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
      }
    }
    check(Object.keys(errors).length === 0, 422, 'PARAM_INVALID', '请补充或修改标出的参数。', errors);
    return normalized;
  }
  createDraft(actor, input) {
    const client = this.get(actor, 'client', input.clientId);
    check(actor.role === 'broker', 403, 'ROLE_REQUIRED', '请使用经纪身份创建方案。');
    check(input.productId === product.id && input.schemaVersion === product.schemaVersion, 409, 'SCHEMA_CHANGED', '产品字段版本已变化，请重新打开表单。');
    const params = this.validate(input.params);
    const scenario = input.scenario || 'success';
    check(scenarios.includes(scenario), 422, 'SCENARIO_INVALID', '演示场景不正确。');
    const draft = { id: id('draft'), tenantId: actor.tenantId, ownerId: actor.id, clientId: client.id,
      productId: product.id, productVersion: product.version, schemaVersion: product.schemaVersion,
      params, paramsHash: hash({ productId: product.id, schemaVersion: product.schemaVersion, params }),
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
      check(draft.schemaVersion === product.schemaVersion, 409, 'SCHEMA_CHANGED', '产品字段版本已变化。');
      check(input.confirmed === true, 422, 'CONFIRMATION_REQUIRED', '请先勾选参数确认。');
      const already = this.store.list('job', actor).find(job => job.draftId === draft.id);
      if (already) {
        this.store.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)').run(actor.tenantId, actor.id, key, requestHash, already.id);
        return already;
      }
      this.get(actor, 'client', draft.clientId);
      // Resolve which executor runs this product; refuses a real product that has
      // no configured adapter (no silent fallback to mock). isMock is derived here.
      const exec = this.registry.resolveForProduct(product);
      const siblings = this.store.list('job', actor).filter(job => job.clientId === draft.clientId);
      const job = {
        id: id('job'), tenantId: actor.tenantId, ownerId: actor.id, clientId: draft.clientId, draftId: draft.id,
        params: draft.params, paramsHash: draft.paramsHash, productId: product.id, productVersion: product.version,
        version: siblings.length + 1, schemaVersion: product.schemaVersion, scenario: draft.scenario,
        execution: product.execution ?? { mode: 'mock' },
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
  transition(job, status, text, error = null) {
    job.status = status; job.updatedAt = iso(this.now()); job.nextAt = this.now() + this.stepMs; job.error = error;
    job.history.push({ status, at: job.updatedAt, text }); this.store.put('job', job);
    this.eventForJob(job, `proposal.${status}`, text);
  }
  recover() {
    // Only local, side-effect-free mock work can be safely resumed automatically.
    for (const job of this.store.list('job')) {
      if (!job.isMock && ['running', 'validating'].includes(job.status)) this.transition(job, 'awaiting_manual', '执行中断，需先核实门户结果', 'RESULT_UNKNOWN');
      else if (job.isMock && ['queued', 'running', 'validating'].includes(job.status)) { job.nextAt = this.now(); this.store.put('job', job); }
    }
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      const job = this.store.list('job').reverse().find(j => ['queued', 'running', 'validating'].includes(j.status) && j.nextAt <= this.now());
      if (!job) return;
      const adapter = this.registry.resolve(job);
      // Guard against configuration drift: the adapter that runs a job must agree
      // with the job's recorded isMock, so a real job is never served by the mock.
      if (!adapter || adapter.isMock !== job.isMock) {
        this.transition(job, 'awaiting_manual', '执行器配置与任务标识不一致，已暂停', 'ADAPTER_MISMATCH'); return;
      }
      let outcome;
      try { outcome = await adapter.advance(job, { pdf: this.pdf }); }
      catch { outcome = { kind: 'transition', status: 'awaiting_manual', text: '执行服务异常，结果未知，转人工核实', error: 'RESULT_UNKNOWN' }; }
      this.applyOutcome(job, outcome);
    } finally { this.busy = false; }
  }
  applyOutcome(job, outcome) {
    if (!outcome) return;
    if (outcome.kind === 'artifact') {
      this.store.transaction(() => {
        this.store.artifact(job.id, outcome.bytes); job.artifactHash = createHash('sha256').update(outcome.bytes).digest('hex');
        this.transition(job, 'succeeded', outcome.text);
      });
      return;
    }
    if (outcome.patch) Object.assign(job, outcome.patch);
    this.transition(job, outcome.status, outcome.text, outcome.error ?? null);
  }
  readPdf(actor, jobId) {
    const job = this.get(actor, 'job', jobId);
    check(job.status === 'succeeded', 409, 'NOT_READY', '文件尚未通过核对。');
    const bytes = this.store.readArtifact(jobId); check(bytes, 404, 'FILE_MISSING', '文件尚不可用。'); return bytes;
  }
  package(actor, jobId) {
    const job = this.get(actor, 'job', jobId);
    check(job.status === 'succeeded', 409, 'NOT_READY', '计划书完成后才能查看讲解包。');
    let pack = this.store.get('package', jobId);
    if (!pack) {
      pack = { id: jobId, tenantId: job.tenantId, ownerId: job.ownerId, clientId: job.clientId, revision: 1, status: 'draft', isMock: true,
        note: '先与客户确认缴费安排及资金使用需求，再逐项说明官方材料中的保障和限制。当前为演示资料，不能据此作出投保判断。',
        createdAt: iso(this.now()), updatedAt: iso(this.now()), history: [] };
      this.store.put('package', pack);
    }
    const latest = Math.max(...this.store.list('job', { id: job.ownerId, tenantId: job.tenantId }).filter(j => j.clientId === job.clientId).map(j => j.version));
    return { ...pack, outdated: job.version < latest, job, facts: product.fields.map(field => ({ key: field.key, label: field.label,
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
    const job = this.get(actor, 'job', jobId);
    check(job.status === 'awaiting_manual', 409, 'STATE_CONFLICT', '该任务当前不在人工队列。');
    check(['retry_mock', 'close'].includes(input.action), 422, 'ACTION_INVALID', '请选择有效操作。');
    check(string(input.note).length >= 2, 422, 'NOTE_REQUIRED', '请填写处理说明。');
    if (input.action === 'retry_mock') {
      check(job.isMock, 409, 'MOCK_ONLY', '该操作只适用于模拟任务。');
      check(job.error !== 'PDF_MISMATCH', 409, 'MISMATCH_BLOCKED', '文件错配任务不能直接重试，请关闭并重新确认参数。');
      job.scenario = 'success'; this.transition(job, 'queued', '运营已处理模拟登录问题，重新排队');
    } else this.transition(job, 'failed', '运营已关闭任务，请经纪重新核对后新建');
    this.audit(actor, 'operator.resolved', job.id, string(input.note), job.clientId); return job;
  }
  extract(text) {
    // A deliberately limited local parser; this is not a configured LLM.
    check(typeof text === 'string' && text.length > 0 && text.length <= 3000, 422, 'TEXT_INVALID', '请输入 1–3000 字的需求。');
    const params = {}, evidence = {}, conflicts = [];
    const assign = (key, value, fragment) => { params[key] = value; evidence[key] = fragment; };
    const ages = [...text.matchAll(/(\d{1,3})\s*岁/g)];
    if (ages.length === 1) assign('age', Number(ages[0][1]), ages[0][0]); else if (ages.length > 1) conflicts.push('描述中有多个年龄，请在表单中确认被保险人年龄');
    if (/不吸烟|不抽烟|非吸烟/.test(text) && !/(?:但|改为|实际|是)\s*(?:吸烟|抽烟)/.test(text)) assign('smoker', false, text.match(/不吸烟|不抽烟|非吸烟/)[0]);
    else if (/吸烟|抽烟/.test(text)) { if (/不吸烟|不抽烟/.test(text)) conflicts.push('吸烟状态存在矛盾'); else assign('smoker', true, '吸烟／抽烟'); }
    if (/美元|美金|USD/i.test(text) && /港币|港元|HKD/i.test(text)) conflicts.push('出现两种币种，请确认');
    else if (/美元|美金|USD/i.test(text)) assign('currency', 'USD', '美元／USD');
    else if (/港币|港元|HKD/i.test(text)) assign('currency', 'HKD', '港币／HKD');
    const amount = text.match(/(?:年缴|年交|每年)\s*(\d+(?:\.\d{1,2})?)\s*(万)?/);
    if (amount) { const raw = amount[1]; const [a, b = ''] = raw.split('.'); let cents = BigInt(a) * 100n + BigInt(b.padEnd(2, '0')); if (amount[2]) cents *= 10000n; assign('annualPremium', `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`, amount[0]); }
    const terms = [...text.matchAll(/(\d+)\s*年(?:缴|交)|(?:缴费|交费|缴|交)\s*(\d+)\s*年/g)].map(m => ({ value: m[1] || m[2], raw: m[0] }));
    if (new Set(terms.map(t => t.value)).size === 1) assign('paymentTerm', terms[0].value, terms[0].raw);
    else if (terms.length > 1) conflicts.push('缴费年期存在多个值，请确认');
    if (/被保险人(?:性别)?[：:\s]*(男|女)/.test(text)) assign('gender', text.match(/被保险人(?:性别)?[：:\s]*(男|女)/)[1], '明确的被保险人性别');
    return { params, evidence, conflicts, missing: product.fields.filter(f => params[f.key] === undefined).map(f => f.key), isMock: true, engine: 'local-rule-demo', warning: '当前使用有限规则演示提取，未调用 Dify 或大模型。产品与性别等信息需经纪确认。' };
  }
  assistant(actor, text, clientId) {
    if (clientId) this.get(actor, 'client', clientId);
    check(typeof text === 'string' && text.trim().length > 0 && text.length <= 3000, 422, 'TEXT_INVALID', '请输入 1–3000 字的问题。');
    const record = { id: id('message'), tenantId: actor.tenantId, ownerId: actor.id, clientId: clientId || null, text, createdAt: iso(this.now()), isMock: true };
    if (/计划书|\d+\s*岁|年缴|年交/.test(text)) {
      record.kind = 'extraction'; record.extraction = this.extract(text); record.answer = '已整理为待确认参数。请打开确认表单，补齐缺失项后提交。';
    } else {
      const entry = /失败|人工/.test(text) ? demoKnowledge[2] : /保证|收益|退保/.test(text) ? demoKnowledge[1] : /怎么|如何|生成|流程/.test(text) ? demoKnowledge[0] : null;
      record.kind = 'answer'; record.answer = entry?.answer || '当前演示尚未接入正式知识库，无法核实这项产品问题。你可以先体验参数确认与计划书流程。'; record.source = entry?.source || '演示资料边界';
    }
    this.store.put('message', record); return record;
  }
}
