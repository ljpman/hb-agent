import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAssistantReply } from '../public/assistant-view.mjs';
import { product, demoActors } from '../server/catalog.mjs';
import { Store } from '../server/store.mjs';
import { Service } from '../server/service.mjs';

test('助手视图：真实后端抽取结果保留 false、输入金额、缺项、证据及确认动作', () => {
  const store = new Store();
  try {
    const service = new Service(store);
    const message = service.assistant(demoActors.broker, '陈先生35岁不吸烟，年缴1万美元，5年缴', 'client-chen');
    const html = renderAssistantReply(message, product.fields);
    for (const text of ['allow', '待确认参数卡', '不吸烟', '10000.00', '待补充：被保险人性别', '输入依据：年缴1万', '未调用 Dify', '补充并确认参数', message.compliance.auditId]) assert.ok(html.includes(text), text);
    assert.equal(store.list('draft').length, 0);
    assert.equal(store.list('job').length, 0);
    const conflict = service.assistant(demoActors.broker, '35岁，5年缴与10年缴', 'client-chen');
    assert.match(renderAssistantReply(conflict, product.fields), /需核对冲突/);
    const answer = service.assistant(demoActors.broker, '如何生成', 'client-chen');
    assert.ok(renderAssistantReply(answer, product.fields).includes(answer.source));
  } finally { store.close(); }
});

test('助手视图：逐字段标记 Dify 核实来源；无法核实值不显示且仍待确认', () => {
  const html = renderAssistantReply({
    id: 'm-dify-extract', answer: '已整理待确认参数卡。', engine: 'dify', isMock: false,
    source: 'Dify 识别、后端核实；参数待确认',
    compliance: { decision: 'allow', auditId: 'audit-demo', rules: [] },
    extraction: {
      params: { gender: '女' }, evidence: { gender: '被保险人性别是女' },
      sources: { gender: 'dify-verified' }, unverified: ['age'],
      warning: 'Dify 只提供候选；无法核实的候选已留空。', requiresConfirmation: true,
      engine: 'dify', isMock: false,
    },
  }, product.fields);
  assert.match(html, /Dify 识别、后端核实/);
  assert.match(html, /模型识别到但无法核实，请手动填写/);
  assert.match(html, /参数待确认 · 未提交/);
  assert.match(html, /Dify 只提供候选/);
  assert.ok(!html.includes('36'), 'unverified model candidate values are not displayed');
});

test('助手视图：block 不渲染危险回复、假出处与抽取按钮；所有动态文本转义', () => {
  const injection = '<img src=x onerror=alert(1)>';
  const message = { id: 'demo', answer: injection, source: injection, compliance: { decision: 'block', auditId: injection, rules: [injection] }, extraction: { params: { annualPremium: '99999' } } };
  const blocked = renderAssistantReply(message, product.fields);
  assert.match(blocked, /已转人工/);
  assert.ok(!blocked.includes('<img'));
  assert.ok(!blocked.includes('99999'));
  assert.ok(!blocked.includes('use-extraction'));
  const allowed = renderAssistantReply({ ...message, compliance: { decision: 'allow' }, extraction: { params: { age: injection }, evidence: { age: injection } } }, product.fields);
  assert.ok(!allowed.includes('<img'));
  assert.match(allowed, /&lt;img/);
  assert.ok(!renderAssistantReply({ ...message, compliance: undefined }, product.fields).includes('use-extraction'));
});
