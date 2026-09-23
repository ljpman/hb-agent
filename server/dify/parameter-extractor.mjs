// RL-01d: an amount next to benefit/return wording (e.g. 每年2万回报, 收益每年2万,
// 每年1万美元现金价值) is a benefit figure, never a premium candidate.
const BENEFIT_WORDS = '回报|回報|收益|分红|分紅|红利|紅利|派息|利息|现金价值|現金價值|退保价值|退保價值|领取|領取|返还|返還|提取|回本|赔偿|賠償';
const BENEFIT_BEFORE_RE = new RegExp(`(?:${BENEFIT_WORDS})[^，,。；;！!？?\\n]{0,6}$`);
const BENEFIT_AFTER_RE = new RegExp(`^\\s*(?:美元|美金|港币|港幣|港元|USD|HKD)?\\s*的?\\s*(?:${BENEFIT_WORDS})`, 'i');
const nearBenefit = (text, match) => BENEFIT_BEFORE_RE.test(text.slice(Math.max(0, match.index - 12), match.index)) ||
  BENEFIT_AFTER_RE.test(text.slice(match.index + match[0].length));

// Conservative, deterministic candidates for the offline demo, never benefits.
// Every accepted value retains an exact substring of the original input.
export function extractParameters(text, product) {
  const params = {}, evidence = {}, conflicts = [];
  const fields = new Map(product.fields.map(field => [field.key, field]));
  const collect = (key, matches, parse, { benefitGuard = false } = {}) => {
    const field = fields.get(key);
    if (!field || !matches.length) return;
    if (benefitGuard && matches.some(match => nearBenefit(text, match))) {
      conflicts.push(`${field.label}附近出现收益／回报等利益表述，不能当作${field.label}，请手动确认`); return;
    }
    if (matches.some(match => /(?:不是|并非|是否|不确定|不清楚|可能|大约|约|\d\s*(?:到|至|[-~～—]))\s*$/.test(text.slice(Math.max(0, match.index - 10), match.index)) ||
        /^(?:\s*(?:到|至|[-~～—])\s*\d|\s*[？?])/.test(text.slice(match.index + match[0].length)))) {
      conflicts.push(`${field.label}描述不确定，请手动确认`); return;
    }
    const candidates = matches.map(match => ({ value: parse(match), raw: match[0] }));
    const valid = value => {
      if (value === undefined) return false;
      if (field.type === 'integer') return Number.isInteger(value) && value >= field.min && value <= field.max;
      if (field.type === 'enum') return field.options.includes(value);
      if (field.type === 'boolean') return typeof value === 'boolean';
      if (field.type === 'decimal') {
        const cents = decimalCents(value);
        return cents !== null && cents >= decimalCents(field.min) && cents <= decimalCents(field.max);
      }
      return false;
    };
    if (candidates.some(candidate => !valid(candidate.value))) {
      conflicts.push(`${field.label}格式或范围无法核实，请手动确认`); return;
    }
    if (new Set(candidates.map(candidate => candidate.value)).size > 1) {
      conflicts.push(`${field.label}存在多个不同值，请手动确认`); return;
    }
    params[key] = candidates[0].value;
    evidence[key] = candidates[0].raw;
  };
  collect('age', [...text.matchAll(/(?<![\d.])([+-]?\d+(?:\.\d+)?)\s*岁/g)], m => Number(m[1]));
  collect('gender', [...text.matchAll(/被保险人(?:性别)?[：:\s]*(男|女)/g)], m => m[1]);
  const smoking = [...text.matchAll(/不吸烟|不抽烟|非吸烟|吸烟|抽烟/g)];
  const uncertainSmoking = smoking.some(m => /是否|不确定|不清楚|未知|未确认|未说明|没有说明|并非|不是|可能|以前|曾经|戒烟|戒$/.test(text.slice(Math.max(0, m.index - 8), m.index)) || /^(?:状态)?(?:未知|不确定|未确认)|^[？?]/.test(text.slice(m.index + m[0].length)));
  if (uncertainSmoking) conflicts.push('吸烟状态无法明确，请手动确认');
  else collect('smoker', smoking, m => !/^(不|非)/.test(m[0]));
  collect('currency', [...text.matchAll(/美元|美金|港币|港元|人民币|(?<![A-Za-z])(?:USD|HKD|CNY|RMB|EUR|GBP)(?![A-Za-z])/gi)], m => {
    if (/美元|美金|^USD$/i.test(m[0])) return 'USD';
    if (/港币|港元|^HKD$/i.test(m[0])) return 'HKD';
  });
  collect('annualPremium', [...text.matchAll(/(?:年缴|年交|每年)\s*(?:(?:USD|HKD|美元|美金|港币|港元)\s*)?([+-]?\d[\d,.]*(?:[eE][+-]?\d+)?)\s*(万)?/gi)], m => {
    // Do not truncate precision, scientific notation or malformed grouping.
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(m[1])) return;
    const cents = decimalCents(m[1].replaceAll(',', '')) * (m[2] ? 10000n : 1n);
    return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  }, { benefitGuard: true });
  collect('paymentTerm', [...text.matchAll(/(?<![\d.])([+-]?\d+(?:\.\d+)?)\s*年(?:缴|交)|(?:缴费|交费|缴|交)\s*([+-]?\d+(?:\.\d+)?)\s*年/g)], m => {
    const raw = m[1] || m[2]; return /^\d+$/.test(raw) ? String(Number(raw)) : undefined;
  });
  return { productId: product.id, schemaVersion: product.schemaVersion, params, evidence, conflicts,
    missing: product.fields.filter(field => field.required && params[field.key] === undefined).map(field => field.key),
    requiresConfirmation: true, isMock: true, engine: 'local-rule-demo',
    warning: '当前使用有限规则演示提取，未调用 Dify 或大模型。未识别或有冲突的字段需经纪手动确认。' };
}

function decimalCents(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
