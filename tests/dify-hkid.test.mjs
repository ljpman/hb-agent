import assert from 'node:assert/strict';
import test from 'node:test';

import { demoActors } from '../server/catalog.mjs';
import { Service } from '../server/service.mjs';
import { Store } from '../server/store.mjs';
import { evaluateCompliance, COMPLIANCE_RULES, COMPLIANCE_VERSION, containsHkid, hkidCheckCharacter } from '../server/dify/compliance.mjs';
import { saveCompliance, MANUAL_REPLY } from '../server/dify/gateway.mjs';

// All HKIDs below are synthetic: bodies are arbitrary and the check character is
// computed by the algorithm. No real person's identity number is used.

// Independent reference: the check character c (A = 10) is the one that makes
// (weighted sum + c) divisible by 11. Deliberately a different formulation from
// the production code so a shared mistake is less likely.
function referenceCheck(prefix, digits) {
  const padded = prefix.length === 1 ? [36, prefix.charCodeAt(0) - 55] : [...prefix].map(c => c.charCodeAt(0) - 55);
  const values = [...padded, ...[...digits].map(Number)];
  const sum = values.reduce((total, value, i) => total + value * (9 - i), 0);
  for (let c = 0; c <= 10; c++) if ((sum + c) % 11 === 0) return c === 10 ? 'A' : String(c);
  throw new Error('unreachable');
}
// Deterministically pick synthetic bodies that exercise the '0' and 'A' check characters too.
function bodyWithCheck(prefix, wanted) {
  for (let n = 314159; ; n++) {
    const digits = String(n % 1000000).padStart(6, '0');
    if (referenceCheck(prefix, digits) === wanted) return digits;
  }
}
const synthetic = [
  ['A', '123456'], ['AB', '987654'], ['Z', bodyWithCheck('Z', 'A')], ['XY', bodyWithCheck('XY', '0')], ['K', bodyWithCheck('K', '7')],
].map(([prefix, digits]) => ({ prefix, digits, check: referenceCheck(prefix, digits) }));
const fullWidth = value => value.replace(/[A-Za-z0-9()]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
const blocked = text => {
  const verdict = evaluateCompliance({ text });
  return verdict.decision === 'block' && verdict.rules.includes(COMPLIANCE_RULES.SENSITIVE);
};

test('HKID 校验位：手算样例与独立参考实现一致', () => {
  // A123456: 36×9 + 10×8 + 1×7 + 2×6 + 3×5 + 4×4 + 5×3 + 6×2 = 481; 481 mod 11 = 8; 11 − 8 = 3
  assert.equal(hkidCheckCharacter('A', '123456'), '3');
  // AB987654: 10×9 + 11×8 + 9×7 + 8×6 + 7×5 + 6×4 + 5×3 + 4×2 = 371; 371 mod 11 = 8; 11 − 8 = 3
  assert.equal(hkidCheckCharacter('AB', '987654'), '3');
  // G123456: 36×9 + 16×8 + 77 = 529; 529 mod 11 = 1; 11 − 1 = 10 → "A"
  assert.equal(hkidCheckCharacter('G', '123456'), 'A');
  for (let n = 0; n < 2000; n += 7) {
    const digits = String(n * 499 % 1000000).padStart(6, '0');
    for (const prefix of ['A', 'M', 'Z', 'AB', 'WX', 'ZZ']) assert.equal(hkidCheckCharacter(prefix, digits), referenceCheck(prefix, digits), `${prefix}${digits}`);
  }
  assert.ok(synthetic.some(id => id.check === 'A') && synthetic.some(id => id.check === '0'));
  for (const bad of [['ABC', '123456'], ['1', '123456'], ['A', '12345'], ['A', '1234567']]) assert.equal(hkidCheckCharacter(...bad), null);
});

test('C03：有效 HKID 的半角括号、全角括号、无括号、全角字符与小写括号写法均被拦截', () => {
  assert.equal(COMPLIANCE_VERSION, 'm2a2-3');
  for (const { prefix, digits, check } of synthetic) {
    const forms = [
      `${prefix}${digits}(${check})`, `${prefix}${digits}（${check}）`, `${prefix}${digits}${check}`,
      `${prefix}${digits} (${check})`, fullWidth(`${prefix}${digits}(${check})`), fullWidth(`${prefix}${digits}${check}`),
      `${prefix.toLowerCase()}${digits}(${check.toLowerCase()})`,
    ];
    for (const id of forms) {
      assert.ok(containsHkid(id), id);
      assert.ok(blocked(id), id);
    }
  }
});

test('C03：中文句子中嵌入的 HKID 被拦截', () => {
  for (const { prefix, digits, check } of synthetic) {
    const bracketed = `${prefix}${digits}(${check})`, bare = `${prefix}${digits}${check}`;
    for (const text of [
      `客户香港身份证号${bracketed}已登记，请核对。`, `香港身份证：${bare}，出生年份请另行确认。`,
      `证件号码为${prefix}${digits}（${check}）的客户资料已上传`, `HKID ${bare}`, `投保人（身份证${bare}）已签署`,
    ]) assert.ok(blocked(text), text);
  }
});

test('校验位错误的 HKID 样式不拦截（各种写法）', () => {
  for (const { prefix, digits, check } of synthetic) {
    for (const wrong of '0123456789A'.split('').filter(c => c !== check)) {
      for (const text of [`${prefix}${digits}(${wrong})`, `${prefix}${digits}（${wrong}）`, `${prefix}${digits}${wrong}`, `证件号${prefix}${digits}(${wrong})已登记`]) {
        assert.equal(containsHkid(text), false, text);
        assert.equal(evaluateCompliance({ text }).decision, 'allow', text);
      }
    }
  }
});

test('普通产品代码、保单号样式与标识符不被误判为 HKID', () => {
  const [one, two] = synthetic; // valid bodies, used to prove the boundaries matter
  const lookAlikes = [
    'demo-savings-01', 'DEMO-2026.1', 'HKD1000000', 'USD10000', 'POL12345678', 'SAV2026A', 'AB12345', 'A1234567890',
    `X${two.prefix}${two.digits}(${two.check})`, `P${two.prefix}${two.digits}${two.check}`, // three-letter prefix
    `1${one.prefix}${one.digits}${one.check}`, `${one.prefix}${one.digits}${one.check}9`, // digits glued on
    `${one.prefix.toLowerCase()}${one.digits}${one.check}`, // bare lower case (hex/UUID-like)
    'job-3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9', 'cmp-e1234567', 'artifact:job-callback-file-job',
    '保单号 AB9876540 已提交，请核对。', // same shape, wrong check character
  ];
  for (const text of lookAlikes) {
    assert.equal(containsHkid(text), false, text);
    assert.equal(evaluateCompliance({ text }).decision, 'allow', text);
  }
});

test('既有敏感规则不回归：内地身份证号、密码、Cookie、API key、Bearer 令牌仍拦截', () => {
  for (const text of [
    '客户身份证 12345678901234567X 已登记。', '身份证号123456789012345678请核对', 'password=demo-value', 'Cookie: demo-value',
    'api_key 已配置', 'Authorization: Bearer abcdefghijk.lmnop', '客户身份证 １２３４５６７８９０１２３４５６７Ｘ 已登记。',
  ]) assert.ok(blocked(text), text);
  // Other rules still behave as before and do not pick up the sensitive rule.
  assert.deepEqual(evaluateCompliance({ text: '这款产品保证赚，绝对安全。' }).rules, [COMPLIANCE_RULES.PROMISE]);
  assert.deepEqual(evaluateCompliance({ text: '预期收益 8%。' }).rules, [COMPLIANCE_RULES.UNSOURCED_NUMBER]);
  assert.equal(evaluateCompliance({ text: '已整理为待确认参数。请打开确认表单，补齐缺失项后提交。' }).decision, 'allow');
});

test('HKID 在助手／抽取输入中于进入 Dify 客户端和存储前被拒绝；合规保存只存 hash 与固定提示', () => {
  const store = new Store(':memory:');
  try {
    let calls = 0;
    const dify = { isConfigured: false, status: () => ({ dify: 'not-configured' }), chat: () => { calls++; return { answer: 'x' }; }, extractParams: () => { calls++; return {}; } };
    const service = new Service(store, { dify, stepMs: 0 });
    const { prefix, digits, check } = synthetic[1];
    for (const text of [`客户身份证${prefix}${digits}(${check})，35岁`, `HKID ${prefix}${digits}${check}`]) {
      assert.throws(() => service.assistant(demoActors.broker, text, null), e => e.code === 'SENSITIVE_INPUT');
      assert.throws(() => service.extract(text), e => e.code === 'SENSITIVE_INPUT');
    }
    assert.equal(calls, 0);
    assert.equal(store.list('message').length, 0);
    const draftReply = `已为客户${prefix}${digits}（${check}）整理资料。`;
    const { audit, reply } = saveCompliance(store, demoActors.broker, () => Date.parse('2026-09-23T00:00:00Z'), { originalText: '资料', draftReply });
    assert.equal(audit.decision, 'block');
    assert.ok(audit.rules.includes(COMPLIANCE_RULES.SENSITIVE));
    assert.equal(audit.ruleVersion, 'm2a2-3');
    assert.equal(reply, MANUAL_REPLY);
    assert.ok(!JSON.stringify(store.list('compliance-audit')).includes(`${prefix}${digits}`));
  } finally { store.close(); }
});
