import { renderAssistantReply } from './assistant-view.mjs';
const $ = selector => document.querySelector(selector);
const app = $('#app');
const state = { data: null, draft: null, form: null, key: null, extract: null, pack: null, assistantClient: 'client-chen', filter: 'all', busy: false };
const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = {
  home: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9H13a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8 10h8m-8 4h5"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8m-8 4h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m8 12 3 3 5-6"/>',
  book: '<path d="M12 7v14m0-14C9 4 4 4 2 5v15c3-1 7-1 10 1 3-2 7-2 10-1V5c-2-1-7-1-10 2Z"/>',
  arrowup: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/>',
  alert: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3h.01"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  spark: '<path d="m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8Z"/>'
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`;
const route = () => (location.hash.slice(1) || '/').split('?')[0];
const go = path => { location.hash = path; };
const money = value => Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = value => new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
const time = value => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const clientOf = id => state.data.clients.find(c => c.id === id);
const activeJobs = () => state.data.jobs.filter(j => ['queued', 'running', 'validating'].includes(j.status));
const badge = status => `<span class="status status-${e(status)}"><span></span>${e(state.data.statusLabels[status] || status)}</span>`;
const pill = label => `<span class="pill">${e(label)}</span>`;
const empty = (title, description, action = '') => `<div class="empty">${icon('file')}<strong>${e(title)}</strong><p>${e(description)}</p>${action}</div>`;
const button = (label, action, cls = 'primary', extra = '') => `<button class="button ${cls}" data-action="${action}" ${extra}>${label}</button>`;
function toast(message, error = false) { const node = $('#toast'); node.textContent = message; node.className = `visible ${error ? 'error' : ''}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => node.className = '', 4200); }
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error?.message || '请求失败'); error.details = data.error?.details; error.status = response.status; throw error; }
  return data;
}
async function refresh() { state.data = await api('/bootstrap'); }
function heading(title, subtitle, actions = '') { return `<div class="page-heading"><div><div class="eyebrow">BROKER WORKSPACE</div><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${actions}</div></div>`; }
function jobRows(jobs, compact = false) {
  return jobs.length ? `<div class="job-list">${jobs.map(job => `<a class="job-row" href="#/jobs/${job.id}"><div class="document-icon">${icon('file')}</div><div class="job-row-title"><strong>${e(clientOf(job.clientId)?.name || '演示客户')} · 方案 V${job.version}</strong><span>${e(state.data.product.name)}${compact ? '' : ` · ${job.params.currency} ${money(job.params.annualPremium)} / 年`}</span></div><div class="job-row-end">${badge(job.status)}<small>${date(job.createdAt)} ${time(job.createdAt)}</small></div>${icon('chevron')}</a>`).join('')}</div>` : empty('还没有计划书任务', '从一位客户开始，体验参数确认与生成流程。', '<a href="#/new" class="button secondary">新建演示计划书</a>');
}
function dashboard() {
  const today = new Date().toLocaleDateString('en-CA');
  const due = state.data.clients.filter(c => c.nextAt <= today);
  return heading('今天的工作', `${state.data.actor.name}，把每一位客户的下一步安排好。`, `<a href="#/new" class="button primary">${icon('plus')}新建计划书</a>`) +
    `<div class="metrics"><div><span>待跟进客户 ${icon('people')}</span><strong>${due.length}<small>位</small></strong><a href="#/clients">查看今日安排 ${icon('arrow')}</a></div><div><span>正在生成 ${icon('clock')}</span><strong>${activeJobs().length}<small>份</small></strong><a href="#/jobs">查看任务进度 ${icon('arrow')}</a></div><div><span>已完成计划书 ${icon('file')}</span><strong>${state.data.jobs.filter(j => j.status === 'succeeded').length}<small>份</small></strong><span class="metric-foot">当前均为模拟文件</span></div></div>
    <div class="dashboard-grid"><div class="stack"><section class="panel"><div class="panel-heading"><h2>客户跟进</h2><a href="#/clients">全部客户 ${icon('arrow')}</a></div><div class="client-list">${state.data.clients.map((c, i) => `<a href="#/clients/${c.id}" class="client-row"><span class="avatar ${c.color}">${e(c.initials)}</span><div><strong>${e(c.name)} <span class="subtle-label">演示</span></strong><p>${e(c.nextAction)}</p></div><div class="client-row-end"><span class="date-tag ${i === 0 ? 'today' : ''}">${c.nextAt <= today ? '今日跟进' : date(c.nextAt)}</span><small>${e(c.stage)}</small></div>${icon('chevron')}</a>`).join('')}</div></section>
    <section class="panel"><div class="panel-heading"><h2>最近的计划书</h2><a href="#/jobs">全部任务 ${icon('arrow')}</a></div>${jobRows(state.data.jobs.slice(0, 3), true)}</section></div>
    <aside class="stack"><section class="start-card"><div class="spark-emblem">${icon('spark')}</div><div class="eyebrow">让沟通准备更从容</div><h2>一份计划书，<br>一套讲解准备。</h2><p>确认参数后，体验文件生成、讲解包复核和客户跟进的完整流程。</p><a href="#/assistant" class="button dark">开始描述需求 ${icon('arrow')}</a><div class="start-foot">${icon('shield')}数字不由模型计算</div></section><section class="panel compact-panel"><h2>本次演示范围</h2><div class="scope-line"><span class="tiny-dot ready"></span>表单、任务与跟进可操作</div><div class="scope-line"><span class="tiny-dot ready"></span>讲解包支持复核与导出</div><div class="scope-line"><span class="tiny-dot waiting"></span>真实保司资料待接入</div><a href="#/products" class="text-link">查看产品与对接状态 ${icon('arrow')}</a></section></aside></div>`;
}
function clients() {
  return heading('客户跟进', '需求、方案版本与下一步，放在同一张卡片里。') + `<div class="client-cards">${state.data.clients.map(c => `<article class="panel client-card"><div class="card-top"><span class="avatar large ${c.color}">${e(c.initials)}</span>${pill(c.stage)}</div><h2>${e(c.name)} <span class="subtle-label">演示客户</span></h2><p class="goal">${e(c.goal)}</p><div class="client-card-bottom"><div><span>下一步 · ${date(c.nextAt)}</span><p>${e(c.nextAction)}</p></div><a href="#/clients/${c.id}" class="button secondary full">查看客户 ${icon('arrow')}</a></div></article>`).join('')}</div>`;
}
function clientDetail(id) {
  const c = clientOf(id); if (!c) return empty('客户不可见', '请返回客户列表。');
  const jobs = state.data.jobs.filter(j => j.clientId === c.id);
  const events = state.data.events.filter(v => v.clientId === c.id);
  return `<a class="back-link" href="#/clients">${icon('back')}客户跟进</a>` + heading(`${e(c.name)} <span class="title-tag">演示客户</span>`, e(c.goal), `<a class="button primary" href="#/new?client=${c.id}">${icon('plus')}为客户出方案</a>`) +
    `<div class="detail-grid"><div class="stack"><section class="panel"><div class="panel-heading"><h2>方案与文件</h2><span>${jobs.length} 个版本</span></div>${jobRows(jobs)}</section><section class="panel"><div class="panel-heading"><h2>工作时间线</h2><span>仅当前客户</span></div><div class="timeline">${events.length ? events.map(v => `<div class="timeline-item"><span class="timeline-dot"></span><div><strong>${e(v.detail)}</strong><p>${e(v.actorName)} · ${date(v.createdAt)} ${time(v.createdAt)}</p></div></div>`).join('') : '<p class="muted">确认方案、复核讲解包和修改跟进后，记录会出现在这里。</p>'}</div></section></div>
    <section class="panel followup-panel"><h2>下一次跟进</h2><p class="muted">这是经纪工作记录，不是保司实时状态。</p><form id="followup-form" data-client="${c.id}" data-revision="${c.revision}"><label>跟进阶段<select name="stage">${state.data.followupStages.map(v => `<option ${c.stage === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label>下次跟进日期<input type="date" name="nextAt" value="${e(c.nextAt)}" required></label><label>下一步动作<input name="nextAction" maxlength="300" value="${e(c.nextAction)}" required></label><label>沟通备注<textarea name="notes" rows="5" maxlength="2000">${e(c.notes)}</textarea></label><div class="form-error" role="alert"></div><button class="button primary full">保存跟进记录</button></form></section></div>`;
}
function assistant() {
  const messages = state.data.messages.filter(m => m.clientId === state.assistantClient);
  return heading('智能助理', '先说出需求，再由你确认每个关键参数。') + `<div class="assistant-layout"><section class="panel chat-panel"><div class="chat-header"><div class="assistant-symbol">${icon('spark')}</div><div><strong>经纪业务助理</strong><p>本地流程演示 · 正式知识库待接入</p></div><label class="chat-client"><span class="sr-only">当前客户</span><select id="assistant-client">${state.data.clients.map(c => `<option value="${c.id}" ${c.id === state.assistantClient ? 'selected' : ''}>${e(c.name)} · 演示</option>`).join('')}</select></label></div><div class="chat-messages"><div class="welcome-message"><div class="assistant-symbol">${icon('spark')}</div><h2>从客户的一句话开始。</h2><p>描述年龄、预算和缴费安排，我会先整理成一张待确认参数卡。</p><button class="suggestion" data-action="sample-prompt">35岁，不吸烟，年缴1万美元，缴5年 ${icon('arrow')}</button></div>${messages.map(m => `<div class="message user-message"><span class="message-label">你</span><p>${e(m.text)}</p></div>${renderAssistantReply(m, state.data.product.fields)}`).join('')}</div><form id="assistant-form" class="composer"><label class="sr-only" for="message-input">输入客户需求或问题</label><textarea id="message-input" name="text" rows="2" placeholder="例如：35岁，不吸烟，年缴1万美元，缴5年…" maxlength="3000" required></textarea><div class="composer-bottom"><span>先确认，再生成 · 不自动提交计划书</span><button class="send-button" aria-label="发送需求">${icon('arrowup')}</button></div></form></section><aside class="stack"><section class="panel compact-panel"><h2>你可以从这些问题开始</h2>${state.data.knowledge.map((item, index) => `<button class="question-link" data-action="ask-question" data-index="${index}">${e(item.question)}${icon('chevron')}</button>`).join('')}</section><section class="assistant-tip">${icon('shield')}<h3>关键参数，由你确认</h3><p>未知信息会留空。姓名、称谓不会被直接认定为被保险人性别。</p><a href="#/new">也可以直接填写表单 ${icon('arrow')}</a></section></aside></div>`;
}
function currentForm() {
  const queryClient = new URLSearchParams(location.hash.split('?')[1] || '').get('client');
  return state.form || { clientId: queryClient || state.data.clients[0]?.id, params: {}, scenario: 'success' };
}
function fieldControl(field, value) {
  if (field.type === 'enum' || field.type === 'boolean') {
    const options = field.type === 'boolean' ? [{ value: 'false', label: '不吸烟' }, { value: 'true', label: '吸烟' }] : field.options.map(v => ({ value: v, label: field.key === 'paymentTerm' ? `${v} 年` : v }));
    return `<select name="${field.key}" id="field-${field.key}" required><option value="">请选择</option>${options.map(o => `<option value="${o.value}" ${String(value) === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`;
  }
  return `<div class="input-with-unit"><input id="field-${field.key}" name="${field.key}" type="number" inputmode="${field.type === 'integer' ? 'numeric' : 'decimal'}" min="${field.min}" max="${field.max}" step="${field.type === 'integer' ? '1' : '0.01'}" value="${e(value)}" placeholder="${field.key === 'age' ? '例如 35' : '例如 10000'}" required>${field.key === 'age' ? '<span>岁</span>' : ''}</div>`;
}
function newProposal() {
  if (state.draft) return confirmation();
  const f = currentForm();
  return heading('新建计划书', '选好客户与参数，我们把每一步记录清楚。') +
    `<div class="steps"><span class="active"><b>1</b>填写需求</span><i></i><span><b>2</b>核对参数</span><i></i><span><b>3</b>生成与讲解</span></div><div class="form-layout"><form id="proposal-form" class="panel proposal-form"><div class="panel-heading"><h2>客户与产品</h2><span class="pill">演示流程</span></div><label>所属客户<select name="clientId" required>${state.data.clients.map(c => `<option value="${c.id}" ${c.id === f.clientId ? 'selected' : ''}>${e(c.name)}（演示）</option>`).join('')}</select></label><div class="product-choice"><span class="product-monogram">示</span><div><strong>演示储蓄计划</strong><p>示例保司 · DEMO-2026.1</p></div>${icon('check')}</div><div class="section-divider"></div><div class="panel-heading"><h2>被保险人与缴费参数</h2></div>${state.extract?.conflicts?.length ? `<div class="notice warning">${e(state.extract.conflicts.join('；'))}</div>` : ''}<div class="form-fields">${state.data.product.fields.map(field => `<label for="field-${field.key}">${field.label}<span class="required">*</span>${fieldControl(field, f.params[field.key])}<small class="field-error" data-error="${field.key}"></small></label>`).join('')}</div><details class="scenario-picker"><summary>${icon('settings')}演示场景</summary><p>仅用于验证页面与异常处理，不会访问保司。</p><label>模拟结果<select name="scenario"><option value="success" ${f.scenario === 'success' ? 'selected' : ''}>正常完成</option><option value="manual" ${f.scenario === 'manual' ? 'selected' : ''}>登录过期 · 转人工</option><option value="failed" ${f.scenario === 'failed' ? 'selected' : ''}>门户不可用 · 失败</option><option value="mismatch" ${f.scenario === 'mismatch' ? 'selected' : ''}>文件参数不一致 · 拦截</option></select></label></details><div class="form-error" role="alert"></div><div class="form-footer"><span>${icon('shield')}下一步由你核对，当前不会执行</span><button class="button primary">核对参数 ${icon('arrow')}</button></div></form><aside class="stack"><section class="panel compact-panel"><h2>完成后你会得到</h2><div class="deliverable">${icon('file')}<div><strong>模拟计划书</strong><p>带参数与明确演示标识的 PDF。</p></div></div><div class="deliverable">${icon('book')}<div><strong>讲解包草稿</strong><p>参数摘要、沟通提纲和来源。</p></div></div><div class="deliverable">${icon('people')}<div><strong>客户跟进记录</strong><p>方案版本自动关联到当前客户。</p></div></div></section><div class="aside-note">本页字段和范围仅作交互演示。真实产品参数将在香港脚本与官方资料核实后接入。</div></aside></div>`;
}
function confirmation() {
  const d = state.draft;
  return heading('请核对这份方案的参数', '确认后将按这一版参数创建模拟任务。') + `<div class="steps"><span class="done"><b>${icon('check')}</b>填写需求</span><i></i><span class="active"><b>2</b>核对参数</span><i></i><span><b>3</b>生成与讲解</span></div><section class="panel confirmation-panel"><div class="confirmation-top"><div class="avatar sage">${e(clientOf(d.clientId)?.initials)}</div><div><h2>${e(clientOf(d.clientId)?.name)}的演示方案</h2><p>演示储蓄计划 · 参数版本 ${d.revision}</p></div>${pill('等待你的确认')}</div><dl class="confirmation-facts">${state.data.product.fields.map(field => `<div><dt>${field.label}</dt><dd>${field.key === 'smoker' ? d.params.smoker ? '吸烟' : '不吸烟' : field.key === 'annualPremium' ? `${d.params.currency} ${money(d.params.annualPremium)}` : field.key === 'paymentTerm' ? `${d.params.paymentTerm} 年` : field.key === 'age' ? `${d.params.age} 岁` : e(d.params[field.key])}</dd></div>`).join('')}</dl><div class="notice">${icon('shield')}这是一份模拟任务，生成的文件不是保司正式计划书。修改参数后需要重新确认。</div><form id="confirm-form"><label class="checkbox"><input type="checkbox" name="confirmed" required><span>我已核对以上参数，并了解本次使用模拟服务。</span></label><div class="form-error" role="alert"></div><div class="form-footer">${button(`${icon('back')}返回修改`, 'edit-draft', 'secondary', 'type="button"')}<button class="button primary">确认并生成 ${icon('arrow')}</button></div></form></section>`;
}
function jobs(ops = false) {
  if (ops && state.data.actor.role !== 'operator') return heading('运营队列', '查看需要人工接手的任务。') + `<section class="panel role-intro">${icon('shield')}<h2>以运营身份查看待处理任务</h2><p>演示中，经纪和运营使用不同权限。切换后可以查看本机构的队列。</p>${button('切换为演示运营', 'operator-role')}</section>`;
  const jobs = state.data.jobs.filter(j => ops ? j.status === 'awaiting_manual' : state.filter === 'all' || (state.filter === 'active' ? ['queued', 'running', 'validating'].includes(j.status) : j.status === state.filter));
  return heading(ops ? '运营队列' : '计划书任务', ops ? '核对原因、记录处理，保留每一次操作。' : '从确认参数到文件完成，每一步都有记录。', !ops ? '<a class="button primary" href="#/new">' + icon('plus') + '新建计划书</a>' : '') + `<section class="panel">${!ops ? `<div class="filter-tabs" role="group" aria-label="筛选任务">${[['all', '全部任务'], ['active', '进行中'], ['succeeded', '已完成'], ['awaiting_manual', '待人工'], ['failed', '失败']].map(([key, name]) => `<button data-action="filter-jobs" data-filter="${key}" aria-pressed="${state.filter === key}">${name}</button>`).join('')}</div>` : '<div class="panel-heading"><h2>等待人工处理</h2><span>机构内可见</span></div>'}${jobRows(jobs)}</section>`;
}
function jobDetail(id) {
  const job = state.data.jobs.find(j => j.id === id); if (!job) return empty('任务不可见', '请返回任务列表。');
  const labels = { queued: '任务已加入队列', running: '正在生成模拟文件', validating: '正在核对文件', succeeded: '模拟计划书已准备好', awaiting_manual: '这份任务需要人工处理', failed: '本次生成未完成' };
  const active = ['queued', 'running', 'validating'].includes(job.status);
  return `<a class="back-link" href="#/jobs">${icon('back')}计划书任务</a>` + heading(`${e(clientOf(job.clientId)?.name)} · 方案 V${job.version}`, '演示储蓄计划 · ' + date(job.createdAt) + ' ' + time(job.createdAt), badge(job.status)) + `<div class="detail-grid"><div class="stack"><section class="panel result-panel"><div class="result-icon ${job.status}">${icon(job.status === 'succeeded' ? 'check' : active ? 'clock' : 'alert')}</div><h2>${labels[job.status]}</h2><p>${e(job.history.at(-1)?.text)}</p>${active ? '<div class="indeterminate"><span></span></div><small>你可以离开页面，任务记录会保留。</small>' : ''}${job.status === 'succeeded' ? `<div class="result-actions"><a class="button secondary" href="/api/proposals/${job.id}/download" target="_blank" rel="noopener">${icon('file')}打开模拟 PDF</a><a class="button primary" href="#/packages/${job.id}">${icon('book')}查看讲解包</a></div>` : ''}${['failed', 'awaiting_manual'].includes(job.status) ? `<div class="result-actions">${button('复制参数，新建方案', 'copy-job', 'secondary', `data-id="${job.id}"`)}${job.status === 'awaiting_manual' ? '<a href="#/operations" class="button secondary">前往运营队列</a>' : ''}</div>` : ''}</section><section class="panel"><div class="panel-heading"><h2>处理记录</h2><span>持久保存</span></div><div class="timeline">${job.history.map(h => `<div class="timeline-item"><span class="timeline-dot"></span><div><strong>${e(h.text)}</strong><p>${date(h.at)} ${time(h.at)}</p></div></div>`).join('')}</div></section>${state.data.actor.role === 'operator' && job.status === 'awaiting_manual' ? `<section class="panel followup-panel"><h2>人工处理</h2><form id="resolve-form" data-id="${job.id}"><label>处理说明<textarea name="note" rows="3" required minlength="2" placeholder="记录已核对的情况"></textarea></label><label>处理结果<select name="action">${job.error !== 'PDF_MISMATCH' ? '<option value="retry_mock">模拟登录已恢复，重新排队</option>' : ''}<option value="close">关闭任务，由经纪重新确认</option></select></label><div class="form-error" role="alert"></div><button class="button primary">保存处理结果</button></form></section>` : ''}</div><aside class="panel snapshot-panel"><h2>已确认的参数</h2><dl>${state.data.product.fields.map(f => `<div><dt>${f.label}</dt><dd>${f.key === 'smoker' ? job.params.smoker ? '吸烟' : '不吸烟' : e(job.params[f.key])}</dd></div>`).join('')}</dl><div class="snapshot-footer"><p>${icon('shield')}${e(job.confirmedBy)}已确认</p><small>模拟文件 · V${job.version}</small><small class="mono">${e(job.id.slice(0, 20))}…</small></div>${state.data.actor.role === 'broker' ? button('修改参数，创建新版本', 'copy-job', 'secondary full', `data-id="${job.id}"`) : ''}</aside></div>`;
}
function packagePage() {
  const p = state.pack; if (!p) return '<div class="loading">正在打开讲解包…</div>';
  return `<a class="back-link" href="#/jobs/${p.id}">${icon('back')}返回方案</a>` + heading('方案讲解包', `${e(clientOf(p.clientId)?.name)} · 方案 V${p.job.version} · 讲解包修订 ${p.revision}`, p.status === 'reviewed' && !p.outdated ? `<a class="button primary" href="/api/packages/${p.id}/export">${icon('download')}导出演示讲解包</a>` : pill(p.outdated ? '已有更新方案' : '待经纪复核')) + `<div class="package-layout"><article class="paper"><div class="paper-brand">HB AGENT <span>沟通准备材料</span></div><div class="paper-heading"><small>方案概览 / V${p.job.version}</small><h2>把方案，讲清楚。</h2><p>演示储蓄计划 · ${e(clientOf(p.clientId)?.name)}（演示客户）</p></div><div class="paper-notice">模拟材料，不构成保司计划书或投保建议。</div><dl class="paper-facts">${p.facts.map(f => `<div><dt>${f.label}</dt><dd>${e(f.value)}</dd></div>`).join('')}</dl>${p.sections.map((s, index) => `<section class="paper-section"><span>0${index + 1}</span><div><h3>${e(s.title)}</h3><p>${e(s.text)}</p><a href="/api/proposals/${p.id}/download#page=1" target="_blank" rel="noopener" class="source-note">${icon('book')}模拟参数确认单 · 第 1 页 ${icon('arrow')}</a></div></section>`).join('')}<div class="paper-foot">输入参数来自模拟文件。保障和利益资料尚未接入，不生成收益或退保价值。</div></article><aside class="stack"><section class="panel followup-panel"><h2>沟通备注</h2><p class="muted">保留你的讲解方式。修改后需要重新复核。</p><form id="package-note-form"><label class="sr-only" for="package-note">讲解备注</label><textarea id="package-note" name="note" rows="7" maxlength="3000">${e(p.note)}</textarea><div class="form-error" role="alert"></div><button class="button secondary full">保存备注</button></form></section><section class="panel review-panel"><h2>交付前复核</h2><p>请打开模拟文件核对参数，确认客户与版本一致。</p>${p.outdated ? '<div class="notice warning">已有更新方案，请返回客户记录查看最新版本。</div>' : `<form id="package-review-form"><label class="checkbox"><input name="confirmed" type="checkbox" required ${p.status === 'reviewed' ? 'checked disabled' : ''}><span>已核对参数、来源与演示标识。</span></label><div class="form-error" role="alert"></div><button class="button primary full" ${p.status === 'reviewed' ? 'disabled' : ''}>${p.status === 'reviewed' ? '已完成复核' : '确认复核'}</button></form>`}${p.reviewedAt ? `<small class="reviewed-info">${e(p.reviewedBy)} · ${date(p.reviewedAt)} ${time(p.reviewedAt)}</small>` : ''}</section><a href="#/clients/${p.clientId}" class="button secondary full">更新客户跟进 ${icon('arrow')}</a></aside></div>`;
}
function products() {
  return heading('产品与资料', '演示范围清楚可见，真实能力按验证结果逐项接入。') + `<div class="detail-grid"><section class="panel catalog-panel"><div class="product-choice"><span class="product-monogram">示</span><div><h2>演示储蓄计划</h2><p>示例保司 · DEMO-2026.1</p></div>${pill('仅演示')}</div><p>${e(state.data.product.description)}</p><div class="table-wrap"><table><thead><tr><th>字段</th><th>演示约束</th><th>必填</th></tr></thead><tbody>${state.data.product.fields.map(f => `<tr><td>${f.label}</td><td>${f.options ? f.options.join(' / ') : f.type === 'boolean' ? '吸烟 / 不吸烟' : `${f.min}–${f.max}`}</td><td>是</td></tr>`).join('')}</tbody></table></div><div class="notice">该字段表不能当作真实产品规则。真实 schema 待香港脚本和官方样本核实。</div></section><aside class="stack"><section class="panel compact-panel"><h2>对接状态</h2><div class="integration-row"><strong>香港现有 Python</strong><span>待现场配合</span><p>你们已有多家保司脚本；本地尚未读取或连接。</p></div><div class="integration-row"><strong>知识库与模型</strong><span>待配置</span><p>当前提供本地流程演示与有限规则提取。</p></div><div class="integration-row"><strong>APP 完整 IM</strong><span>待对接</span><p>当前是独立 H5 原型，没有离线推送或真实 IM。</p></div></section></aside></div>`;
}
function shell(content) {
  const path = route(); const actor = state.data.actor;
  const nav = [['/', 'home', '工作台'], ['/assistant', 'chat', '智能助理'], ['/clients', 'people', '客户跟进'], ['/jobs', 'file', '计划书任务']];
  const active = key => key === '/' ? path === '/' : path.startsWith(key) || (key === '/jobs' && ['/new', '/packages'].some(v => path.startsWith(v)));
  return `<div class="app-shell"><aside class="sidebar"><a class="brand" href="#/"><span class="brand-icon">H</span><div>HB Agent<small>经纪业务工作台</small></div></a><div class="workspace-chip"><span class="workspace-icon">HB</span><div>渠道服务空间<small>本地演示环境</small></div></div><div class="nav-caption">工作空间</div><nav>${nav.map(([href, ico, label]) => `<a href="#${href}" class="nav-item ${active(href) ? 'active' : ''}">${icon(ico)}<span>${label}</span>${href === '/jobs' && activeJobs().length ? `<b>${activeJobs().length}</b>` : ''}</a>`).join('')}<div class="nav-caption second">管理</div><a href="#/operations" class="nav-item ${active('/operations') ? 'active' : ''}">${icon('shield')}<span>运营队列</span></a><a href="#/products" class="nav-item ${active('/products') ? 'active' : ''}">${icon('book')}<span>产品与资料</span></a></nav><div class="sidebar-bottom"><div class="sidebar-note">从需求到跟进<br><strong>让每一步都有据可查。</strong></div><button class="profile" data-action="switch-role"><span class="avatar small sage">${actor.role === 'operator' ? '运' : '林'}</span><span>${e(actor.name)}<small>${actor.role === 'operator' ? '演示运营' : '演示经纪'}</small></span>${icon('settings')}</button></div></aside><div class="main-shell"><header class="topbar"><div class="breadcrumbs">渠道服务 <span>/</span> 经纪工作台</div><div class="topbar-right"><span class="environment"><i></i>交互演示</span><span class="topbar-date">${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</span></div></header><div class="demo-banner">${icon('shield')}<span>当前使用演示客户、示例产品与模拟文件。</span><a href="#/products">查看范围 ${icon('arrow')}</a></div><main id="main-content">${content}</main><footer class="app-footer">HB Agent <span>经纪业务助手 · 交互原型 v0.1</span></footer></div></div>`;
}
function render() {
  if (!state.data) return;
  const path = route(); let content;
  if (path === '/') content = dashboard();
  else if (path === '/clients') content = clients();
  else if (path.startsWith('/clients/')) content = clientDetail(path.split('/')[2]);
  else if (path === '/assistant') content = assistant();
  else if (path === '/new') content = newProposal();
  else if (path === '/jobs') content = jobs();
  else if (path.startsWith('/jobs/')) content = jobDetail(path.split('/')[2]);
  else if (path === '/operations') content = jobs(true);
  else if (path.startsWith('/packages/')) content = packagePage();
  else if (path === '/products') content = products();
  else content = empty('页面不存在', '请从左侧导航继续。');
  app.innerHTML = shell(content);
}
async function loadRoute() {
  const current = route();
  if (current !== '/new') { state.draft = null; state.key = null; }
  try {
    await refresh();
    if (current.startsWith('/packages/')) state.pack = await api(`/packages/${current.split('/')[2]}`);
    if (route() === current) render();
  } catch (error) { toast(error.message, true); if (state.data) { app.innerHTML = shell(empty('暂时无法打开', error.message, '<a href="#/jobs" class="button secondary">返回任务</a>')); } }
}
function formError(form, error) {
  const container = form.querySelector('.form-error'); if (container) container.textContent = error.message;
  for (const [key, text] of Object.entries(error.details || {})) { const el = form.querySelector(`[data-error="${key}"]`); if (el) el.textContent = text; const input = form.elements.namedItem(key); input?.setAttribute('aria-invalid', 'true'); }
}
document.addEventListener('submit', async event => {
  const form = event.target; if (!form.id) return; event.preventDefault();
  if (state.busy) return;
  state.busy = true; const submit = form.querySelector('button:not([type="button"])'); if (submit) submit.disabled = true;
  const data = Object.fromEntries(new FormData(form));
  try {
    if (form.id === 'proposal-form') {
      const params = { age: data.age, gender: data.gender, smoker: data.smoker === '' ? '' : data.smoker === 'true', currency: data.currency, annualPremium: data.annualPremium, paymentTerm: data.paymentTerm };
      state.form = { clientId: data.clientId, params, scenario: data.scenario };
      state.draft = await api('/proposal-drafts', { method: 'POST', body: { ...state.form, productId: state.data.product.id, schemaVersion: state.data.product.schemaVersion } });
      state.key = crypto.randomUUID(); render(); window.scrollTo({ top: 0 });
    } else if (form.id === 'confirm-form') {
      const d = state.draft;
      const job = await api('/proposals', { method: 'POST', headers: { 'Idempotency-Key': state.key }, body: { draftId: d.id, revision: d.revision, paramsHash: d.paramsHash, confirmed: data.confirmed === 'on' } });
      state.form = null; state.extract = null; state.draft = null; await refresh(); go(`/jobs/${job.id}`); toast('参数已确认，模拟任务开始处理');
    } else if (form.id === 'assistant-form') {
      await api('/assistant', { method: 'POST', body: { text: data.text, clientId: state.assistantClient } }); await refresh(); render(); $('#message-input')?.focus();
      $('.chat-messages')?.scrollTo({ top: $('.chat-messages').scrollHeight, behavior: 'smooth' });
    } else if (form.id === 'followup-form') {
      await api(`/clients/${form.dataset.client}`, { method: 'PATCH', body: { ...data, revision: Number(form.dataset.revision) } }); await refresh(); render(); toast('客户跟进已保存');
    } else if (form.id === 'package-note-form') {
      state.pack = await api(`/packages/${state.pack.id}`, { method: 'PATCH', body: { note: data.note, revision: state.pack.revision } }); render(); toast('备注已保存，请重新复核');
    } else if (form.id === 'package-review-form') {
      state.pack = await api(`/packages/${state.pack.id}/review`, { method: 'POST', body: { revision: state.pack.revision, confirmed: data.confirmed === 'on' } }); await refresh(); render(); toast('复核完成，可以导出演示讲解包');
    } else if (form.id === 'resolve-form') {
      await api(`/proposals/${form.dataset.id}/resolve`, { method: 'POST', body: data }); await refresh(); render(); toast('处理结果已记录');
    } else if (form.id === 'role-form') {
      await switchRole(data.actor); $('#dialog').close();
    }
  } catch (error) { formError(form, error); toast(error.message, true); }
  finally { state.busy = false; if (submit?.isConnected) submit.disabled = false; }
});
async function switchRole(actor) {
  await api('/demo/session', { method: 'POST', body: { actor } });
  state.form = null; state.draft = null; state.pack = null; await refresh();
  if (actor === 'operator') { if (route() === '/operations') render(); else go('/operations'); } else { if (route() === '/') render(); else go('/'); }
  toast(actor === 'operator' ? '已切换为演示运营身份' : '已切换为演示经纪身份');
}
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]'); if (!target) return;
  const action = target.dataset.action;
  try {
    if (action === 'sample-prompt') { $('#message-input').value = '35岁，不吸烟，年缴1万美元，缴5年，帮我准备一份计划书。'; $('#message-input').focus(); }
    if (action === 'ask-question') { $('#message-input').value = state.data.knowledge[Number(target.dataset.index)].question; $('#message-input').focus(); }
    if (action === 'use-extraction') { const m = state.data.messages.find(m => m.id === target.dataset.id); if (!m?.extraction || m.blocked || m.compliance?.decision !== 'allow') return; state.extract = m.extraction; state.form = { clientId: m.clientId, params: m.extraction.params, scenario: 'success' }; state.draft = null; go('/new'); }
    if (action === 'edit-draft') { state.draft = null; render(); }
    if (action === 'filter-jobs') { state.filter = target.dataset.filter; render(); }
    if (action === 'copy-job') { const j = state.data.jobs.find(j => j.id === target.dataset.id); state.form = { clientId: j.clientId, params: j.params, scenario: 'success' }; state.draft = null; state.extract = null; go('/new'); }
    if (action === 'operator-role') await switchRole('operator');
    if (action === 'switch-role') {
      $('#dialog').innerHTML = `<form id="role-form"><div class="dialog-header"><h2 id="dialog-title">切换演示身份</h2><button type="button" data-action="close-dialog" aria-label="关闭">×</button></div><p>仅用于本地体验不同的访问权限，不是真实登录。</p><label>演示角色<select name="actor"><option value="broker" ${state.data.actor.role === 'broker' ? 'selected' : ''}>林经理 · 经纪</option><option value="operator" ${state.data.actor.role === 'operator' ? 'selected' : ''}>运营专员 · 机构队列</option></select></label><div class="form-error" role="alert"></div><button class="button primary full">进入所选视角</button></form>`; $('#dialog').showModal();
    }
    if (action === 'close-dialog') $('#dialog').close();
  } catch (error) { toast(error.message, true); }
});
document.addEventListener('change', event => { if (event.target.id === 'assistant-client') { state.assistantClient = event.target.value; render(); } });
window.addEventListener('hashchange', () => { loadRoute(); window.scrollTo({ top: 0 }); });
async function init() {
  try { try { await refresh(); } catch (error) { if (error.status !== 401) throw error; await api('/demo/session', { method: 'POST', body: { actor: 'broker' } }); await refresh(); } await loadRoute(); }
  catch (error) { app.innerHTML = `<div class="startup-error"><h1>工作台暂未就绪</h1><p>${e(error.message)}</p><button class="button primary" id="retry-init">重新连接</button></div>`; $('#retry-init').addEventListener('click', init); }
}
setInterval(async () => {
  if (!state.data || state.busy || document.hidden) return;
  const path = route(); if (!['/', '/jobs', '/operations'].includes(path) && !path.startsWith('/jobs/')) return;
  try { const before = JSON.stringify(state.data.jobs.map(j => [j.id, j.status])); await refresh(); if (before !== JSON.stringify(state.data.jobs.map(j => [j.id, j.status])) && !['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement?.tagName)) render(); } catch { /* A transient poll failure must not erase the current view. */ }
}, 1800);
init();
