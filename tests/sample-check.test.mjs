import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkSamplePackage } from '../scripts/check-samples.mjs';

// Fixture packages use placeholder codes only; no real product or customer data.
const pdf = id => Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Note (fixture ${id}) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function buildPackage(t, { count = 3, mutate = () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hb-samples-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = { batchId: 'B01', submittedAt: '2026-09-23', productCode: 'PCODE', productVersion: 'V 1/2', samples: [], negative: [] };
  const files = { 'README.md': '# fixture', 'product/field-map.md': '# map' };
  for (let i = 1; i <= count; i++) {
    const id = `S0${i}`; const bytes = pdf(id); const fileName = `${id}__PCODE__V-1-2.pdf`;
    manifest.samples.push({ sampleId: id, purpose: 'fixture', pdfSha256: sha(bytes) });
    files[`samples/${id}/input.json`] = { specVersion: '1', sampleId: id, productCode: 'PCODE', productVersion: 'V 1/2',
      params: { FIELD_A: '35', FIELD_B: false, FIELD_C: '10000.00' },
      portalEntries: ['FIELD_A', 'FIELD_B', 'FIELD_C'].map(fieldCode => ({ fieldCode, portalLabel: 'label', control: 'input', enteredValue: 'x', source: 'entered' })) };
    files[`samples/${id}/meta.json`] = { sampleId: id, product: { productVersion: 'V 1/2' },
      pdf: { fileName, sha256: sha(bytes), sizeBytes: bytes.length, pageCount: 1, textExtractable: true, passwordProtected: false },
      desensitization: { approach: 'fictitious-at-generation', modifiedPdf: false }, validity: { confirmedByRole: '产品专家' }, knownIssues: [] };
    files[`samples/${id}/checklist.md`] = '# checklist';
    files[`samples/${id}/${fileName}`] = bytes;
  }
  files['manifest.json'] = manifest;
  mutate(files);
  for (const [path, content] of Object.entries(files)) {
    if (content === undefined) continue;
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), Buffer.isBuffer(content) || typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const errors = result => result.problems.filter(p => p.level === 'error').map(p => `${p.file}: ${p.message}`);

test('结构完整的样本包通过，版本中的空格和斜杠按规范替换为 -', t => {
  const result = checkSamplePackage(buildPackage(t));
  assert.deepEqual(errors(result), []);
  assert.equal(result.ok, true);
  assert.equal(result.samples, 3);
});

test('不足 3 组只提醒，可先开始编写规则', t => {
  const result = checkSamplePackage(buildPackage(t, { count: 1 }));
  assert.equal(result.ok, true);
  assert.ok(result.problems.some(p => p.level === 'warning' && p.message.includes('3–5')));
});

test('§8 退回情形与哈希、版本、文件名问题都报错，且不输出参数或 PDF 内容', t => {
  const cases = [
    [files => { files['samples/S01/checklist.md'] = undefined; }, 'checklist.md'],
    [files => { files['samples/S02/S02__PCODE__V-1-2.pdf'] = Buffer.from('<!DOCTYPE html><title>login</title>'); }, 'PDF 结构不合格'],
    [files => { files['samples/S01/meta.json'].pdf.passwordProtected = true; }, '不加密'],
    [files => { files['samples/S01/input.json'].productVersion = 'V2'; }, '同一批样本必须同一版本'],
    [files => { files['samples/S01/input.json'].params.FIELD_C = 10000.5; }, '十进制定点字符串'],
    [files => { files['samples/S01/input.json'].params.FIELD_C = '1e4'; }, '科学记数法'],
    [files => { files['samples/S01/input.json'].params.FIELD_B = null; }, 'knownIssues'],
    [files => { files['samples/S01/input.json'].portalEntries.pop(); }, '未覆盖字段 FIELD_C'],
    [files => { files['manifest.json'].samples[0].pdfSha256 = '0'.repeat(64); }, 'pdfSha256'],
    [files => { files['samples/S01/meta.json'].desensitization = { modifiedPdf: true }; }, '文字层'],
    [files => { files['samples/S01/客户资料.txt'] = 'x'; }, 'ASCII'],
    [files => { files['samples/S01/extra.pdf'] = pdf('extra'); }, '只有 1 个 PDF'],
    [files => { files['product/field-map.md'] = undefined; }, '字段映射'],
  ];
  for (const [mutate, expected] of cases) {
    const result = checkSamplePackage(buildPackage(t, { mutate }));
    assert.equal(result.ok, false, expected);
    assert.ok(errors(result).some(message => message.includes(expected)), `${expected}: ${errors(result).join(' | ')}`);
    assert.equal(JSON.stringify(result).includes('10000'), false);
  }
});

test('目录不存在时报错', () => {
  assert.equal(checkSamplePackage(join(tmpdir(), 'hb-samples-missing-dir')).ok, false);
});
