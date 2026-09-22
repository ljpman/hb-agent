import { demoKnowledge } from '../catalog.mjs';

// LocalFallbackDifyClient — the deliberately limited local engine used when no
// real Dify instance is configured. It is NOT an LLM and never claims to have
// called one. It only extracts parameter candidates and answers from the demo
// knowledge edge; it computes no benefit/return/cash-value numbers.
export class LocalFallbackDifyClient {
  isConfigured = false;

  status() { return { dify: 'not-configured' }; }

  // Text → product parameter candidates (mirrors the proposal_extract workflow).
  // Deterministic; never fabricates missing fields, never computes money.
  extractParams({ text, product }) {
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
    return {
      params, evidence, conflicts,
      missing: product.fields.filter(f => params[f.key] === undefined).map(f => f.key),
      isMock: true, engine: 'local-rule-demo',
      warning: '当前使用有限规则演示提取，未调用 Dify 或大模型。产品与性别等信息需经纪确认。',
    };
  }

  // Intent + reply draft (mirrors the broker_assistant_chat workflow). Returns a
  // draft only; the backend runs the compliance guard before anything is sent.
  chat({ text, product }) {
    if (/计划书|\d+\s*岁|年缴|年交/.test(text)) {
      return { kind: 'extraction', extraction: this.extractParams({ text, product }), answer: '已整理为待确认参数。请打开确认表单，补齐缺失项后提交。', engine: 'local-fallback' };
    }
    const entry = /失败|人工/.test(text) ? demoKnowledge[2] : /保证|收益|退保/.test(text) ? demoKnowledge[1] : /怎么|如何|生成|流程/.test(text) ? demoKnowledge[0] : null;
    return { kind: 'answer', answer: entry?.answer || '当前演示尚未接入正式知识库，无法核实这项产品问题。你可以先体验参数确认与计划书流程。', source: entry?.source || '演示资料边界', engine: 'local-fallback' };
  }
}
