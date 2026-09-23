import assert from 'node:assert/strict';
import test from 'node:test';

import { createPdfVerifier, inspectPdfStructure, VERIFY } from '../server/verify/pdf-verifier.mjs';

const pdf = body => Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Note (${body}) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
const fields = [
  { key: 'age', type: 'integer' },
  { key: 'gender', type: 'enum' },
  { key: 'smoker', type: 'boolean' },
  { key: 'annualPremium', type: 'decimal' },
];
const job = {
  id: 'job-1', productId: 'real-product', productVersion: 'v1',
  params: { age: 35, gender: '男', smoker: false, annualPremium: '10000.00' },
  productSnapshot: { fields },
};
const located = (overrides = {}) => ({
  productVersion: { value: 'v1', page: 1 },
  fields: { age: { value: '35', page: 2 }, gender: { value: '男', page: 2 }, smoker: { value: false, page: 2 }, annualPremium: { value: '10,000.00', page: 3 }, ...overrides },
});
const verifierFor = extract => createPdfVerifier({ rules: [{ productId: 'real-product', productVersion: 'v1', extract }] });

test('PDF 结构按内容判断：HTML、图片、压缩包、空文件、截断、加密与超限都不通过', () => {
  assert.deepEqual(inspectPdfStructure(pdf('ok')), { ok: true });
  const cases = [
    [Buffer.alloc(0), 'EMPTY'], ['not a buffer', 'EMPTY'],
    [Buffer.from('<!DOCTYPE html><title>Login</title>'), 'NOT_PDF', 'html'],
    [Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), 'NOT_PDF', 'image'],
    [Buffer.from('PK\x03\x04archive', 'latin1'), 'NOT_PDF', 'zip'],
    [Buffer.from('  %PDF-1.7 leading bytes\n%%EOF'), 'NOT_PDF'],
    [Buffer.from('%PDF-1.7\n1 0 obj << >> endobj'), 'TRUNCATED'],
    [Buffer.from('%PDF-1.7\ntrailer << /Encrypt 5 0 R >>\n%%EOF'), 'ENCRYPTED'],
  ];
  for (const [bytes, problem, detected] of cases) {
    const result = inspectPdfStructure(bytes);
    assert.equal(result.ok, false);
    assert.equal(result.problem, problem);
    if (detected) assert.equal(result.detected, detected);
  }
  assert.equal(inspectPdfStructure(pdf('large'), { maxBytes: 10 }).problem, 'TOO_LARGE');
});

test('没有该产品版本的核验规则时一律无法核验，不会通过', async () => {
  const verifier = createPdfVerifier();
  const result = await verifier.verify({ bytes: pdf('x'), job });
  assert.equal(result.status, VERIFY.unverifiable);
  assert.equal(result.problem, 'NO_RULES');
  assert.equal(verifier.hasRules(job), false);
  // 其他版本的规则不适用于本任务。
  const other = createPdfVerifier({ rules: [{ productId: 'real-product', productVersion: 'v2', extract: () => located() }] });
  assert.equal((await other.verify({ bytes: pdf('x'), job })).problem, 'NO_RULES');
});

test('结构不合格时不调用产品规则，直接判定不一致', async () => {
  let called = false;
  const result = await verifierFor(() => { called = true; return located(); }).verify({ bytes: Buffer.from('<html>login</html>'), job });
  assert.equal(result.status, VERIFY.mismatch);
  assert.equal(result.problem, 'NOT_PDF');
  assert.equal(called, false);
});

test('全部确认字段与版本逐项一致才通过；证据只记字段、页码与结果，不含 PDF 数值', async () => {
  const bytes = pdf('ok');
  const result = await verifierFor(({ job: copy }) => { copy.params.age = 99; return located(); }).verify({ bytes, job });
  assert.equal(result.status, VERIFY.passed);
  assert.equal(job.params.age, 35, '规则拿到的是副本，不能改写确认快照');
  assert.equal(result.ruleSet, 'real-product@v1');
  assert.equal(result.fileSha256.length, 64);
  assert.deepEqual(result.checks.map(c => c.field), ['productVersion', 'age', 'gender', 'smoker', 'annualPremium']);
  assert.ok(result.checks.every(c => c.match === true && Number.isInteger(c.page)));
  assert.equal(JSON.stringify(result).includes('10,000'), false);
  assert.equal(JSON.stringify(result).includes('10000'), false);
});

test('金额按确定性规则归一：千分位、整数与两位小数等价，其他写法无法核验', async () => {
  for (const value of ['10000', '10000.0', '10,000', ' 10000.00 ']) {
    assert.equal((await verifierFor(() => located({ annualPremium: { value, page: 3 } })).verify({ bytes: pdf('x'), job })).status, VERIFY.passed, value);
  }
  for (const value of ['1e4', '10,00.00', '10000.001', 'USD 10000', 10000, '']) {
    assert.equal((await verifierFor(() => located({ annualPremium: { value, page: 3 } })).verify({ bytes: pdf('x'), job })).problem, 'UNPARSEABLE', String(value));
  }
});

test('值不同判不一致；非吸烟 false 是有效值，不当缺失', async () => {
  const cases = [
    { annualPremium: { value: '10000.01', page: 3 } },
    { smoker: { value: true, page: 2 } },
    { age: { value: '36', page: 2 } },
    { gender: { value: '女', page: 2 } },
  ];
  for (const override of cases) {
    const result = await verifierFor(() => located(override)).verify({ bytes: pdf('x'), job });
    assert.equal(result.status, VERIFY.mismatch);
    assert.equal(result.checks.filter(c => !c.match).length, 1);
  }
  const wrongVersion = await verifierFor(() => ({ ...located(), productVersion: { value: 'v0', page: 1 } })).verify({ bytes: pdf('x'), job });
  assert.equal(wrongVersion.status, VERIFY.mismatch);
  assert.equal(wrongVersion.checks[0].match, false);
});

test('缺字段、缺页码、规则异常或返回非法结构时无法核验', async () => {
  const { smoker, ...withoutSmoker } = located().fields;
  const cases = [
    [() => ({ ...located(), fields: withoutSmoker }), 'INCOMPLETE'],
    [() => located({ age: { value: '35' } }), 'INCOMPLETE'],
    [() => located({ age: { value: '35', page: 0 } }), 'INCOMPLETE'],
    [() => ({ fields: located().fields }), 'INCOMPLETE'],
    [() => null, 'INCOMPLETE'],
    [() => located({ smoker: { value: 'false', page: 2 } }), 'UNPARSEABLE'],
    [() => ({ ...located(), productVersion: { value: 1, page: 1 } }), 'UNPARSEABLE'],
    [() => { throw new Error('parser crashed'); }, 'EXTRACT_FAILED'],
    [async () => { throw new Error('async parser crashed'); }, 'EXTRACT_FAILED'],
  ];
  for (const [extract, problem] of cases) {
    const result = await verifierFor(extract).verify({ bytes: pdf('x'), job });
    assert.equal(result.status, VERIFY.unverifiable);
    assert.equal(result.problem, problem);
  }
  const noSnapshot = await verifierFor(() => located()).verify({ bytes: pdf('x'), job: { ...job, productSnapshot: undefined } });
  assert.equal(noSnapshot.problem, 'NO_SNAPSHOT');
});

test('规则注册必须完整且唯一', () => {
  assert.throws(() => createPdfVerifier({ rules: [{ productId: 'p', productVersion: 'v' }] }), TypeError);
  const rule = { productId: 'p', productVersion: 'v', extract: () => null };
  assert.throws(() => createPdfVerifier({ rules: [rule, { ...rule }] }), TypeError);
});
