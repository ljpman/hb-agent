import assert from 'node:assert/strict';
import test from 'node:test';
import { product, demoActors } from '../server/catalog.mjs';
import { extractParameters } from '../server/dify/parameter-extractor.mjs';
import { Service } from '../server/service.mjs';
import { Store } from '../server/store.mjs';

// Explicit offline acceptance corpus. These are not model accuracy claims.
const accepted = [
  ['35岁', 'age', 35], ['18岁', 'age', 18], ['70岁', 'age', 70], ['035岁', 'age', 35],
  ['35岁，确认35岁', 'age', 35], ['被保险人男', 'gender', '男'], ['被保险人性别：女', 'gender', '女'],
  ['被保险人性别 男', 'gender', '男'], ['不吸烟', 'smoker', false], ['不抽烟', 'smoker', false],
  ['非吸烟', 'smoker', false], ['吸烟', 'smoker', true], ['抽烟', 'smoker', true],
  ['不吸烟，非吸烟', 'smoker', false], ['美元', 'currency', 'USD'], ['美金', 'currency', 'USD'],
  ['usd', 'currency', 'USD'], ['港币', 'currency', 'HKD'], ['港元', 'currency', 'HKD'],
  ['HKD', 'currency', 'HKD'], ['美元 USD 美金', 'currency', 'USD'],
  ['年缴1万美元', 'annualPremium', '10000.00'], ['年交1.25万', 'annualPremium', '12500.00'],
  ['每年10000.5', 'annualPremium', '10000.50'], ['年缴1,000', 'annualPremium', '1000.00'],
  ['年缴1,000,000.00', 'annualPremium', '1000000.00'], ['年缴USD10000', 'annualPremium', '10000.00'],
  ['年缴HKD 10000.50', 'currency', 'HKD'], ['年缴1万，年交10000', 'annualPremium', '10000.00'],
  ['5年缴', 'paymentTerm', '5'], ['10年交', 'paymentTerm', '10'], ['缴费5年', 'paymentTerm', '5'],
  ['交费10年', 'paymentTerm', '10'], ['缴5年，5年缴', 'paymentTerm', '5'], ['05年缴', 'paymentTerm', '5'],
];
const rejected = [
  ['35岁，40岁', 'age'], ['17岁', 'age'], ['71岁', 'age'], ['135岁', 'age'], ['35.5岁', 'age'],
  ['-35岁', 'age'], ['35至40岁', 'age'], ['不是35岁', 'age'], ['可能35岁', 'age'],
  ['被保险人男，被保险人女', 'gender'], ['被保险人性别女？', 'gender'],
  ['不吸烟，吸烟', 'smoker'], ['非吸烟，实际吸烟', 'smoker'], ['不抽烟，但抽烟', 'smoker'],
  ['是否吸烟', 'smoker'], ['不是不吸烟', 'smoker'], ['吸烟状态未知', 'smoker'], ['以前吸烟', 'smoker'],
  ['美元和港元', 'currency'], ['人民币', 'currency'], ['USD和EUR', 'currency'],
  ['年缴1万，年缴2万', 'annualPremium'], ['年缴1000.123', 'annualPremium'], ['年缴1.234万', 'annualPremium'],
  ['年缴1,00', 'annualPremium'], ['年缴1e4', 'annualPremium'], ['年缴-10000', 'annualPremium'],
  ['年缴999.99', 'annualPremium'], ['年缴1000000.01', 'annualPremium'], ['年缴1万到2万', 'annualPremium'],
  ['5年缴和10年缴', 'paymentTerm'], ['3年缴', 'paymentTerm'], ['5.5年缴', 'paymentTerm'],
  ['缴-5年', 'paymentTerm'], ['5至10年缴', 'paymentTerm'],
];
function extract(text) {
  const result = extractParameters(text, product);
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.productId, product.id);
  assert.equal(result.schemaVersion, product.schemaVersion);
  assert.equal(result.isMock, true);
  for (const [key, fragment] of Object.entries(result.evidence)) {
    assert.ok(text.includes(fragment), `${key} evidence must be an original substring`);
    assert.notEqual(result.params[key], undefined);
  }
  for (const field of product.fields) assert.equal(result.missing.includes(field.key), result.params[field.key] === undefined);
  return result;
}
for (const [text, key, value] of accepted) test(`离线提取保留有效输入：${text}`, () => {
  const result = extract(text);
  assert.equal(result.params[key], value);
  assert.equal(result.conflicts.length, 0);
});
for (const [text, key] of rejected) test(`离线提取留空并提示：${text}`, () => {
  const result = extract(text);
  assert.equal(result.params[key], undefined);
  assert.ok(result.conflicts.length > 0);
});

test('称谓不推断性别，收益数字不变成保费，不支持表达保持缺失', () => {
  for (const text of ['陈先生', '林女士', '收益10000美元', '年缴一万美元', '年龄未知']) {
    const result = extract(text);
    assert.equal(result.params.gender, undefined);
    assert.equal(result.params.annualPremium, undefined);
  }
});

test('完整输入可验证；助手冲突参数留空且不会产生草稿或任务', () => {
  const store = new Store(':memory:');
  try {
    const service = new Service(store);
    const text = '陈先生35岁，不吸烟，被保险人性别男，年缴1万美元，5年缴';
    const result = service.extract(text);
    assert.deepEqual(service.validate(result.params), result.params);
    const reply = service.assistant(demoActors.broker, '陈先生35岁，不吸烟，年缴1万美元，年缴2万美元，5年缴', 'client-chen');
    assert.equal(reply.compliance.decision, 'allow');
    assert.equal(reply.extraction.params.annualPremium, undefined);
    assert.ok(reply.extraction.conflicts.length);
    assert.equal(store.list('draft').length, 0);
    assert.equal(store.list('job').length, 0);
  } finally { store.close(); }
});
