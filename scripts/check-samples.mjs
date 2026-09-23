import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { inspectPdfStructure } from '../server/verify/pdf-verifier.mjs';

// Intake check for an M1b sample package (docs/handoff/m1b/sample-spec.md).
// It validates structure, metadata, hashes and PDF file structure so a package
// can be returned (§8) before anyone writes verification rules. It does NOT
// compare PDF contents with inputs: per-field rules are written from the signed
// checklist.md once real samples arrive, and are never guessed here.
//
//   node scripts/check-samples.mjs <package-dir> [--json]
//
// Output lists problems by file and field only. It never prints parameter or
// PDF values, since samples may be real documents.

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safeVersion = value => String(value).replace(/[^A-Za-z0-9._-]/g, '-');

function readJson(path, report, label) {
  if (!existsSync(path)) { report.error(label, '缺少文件'); return null; }
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { report.error(label, '不是有效的 JSON'); return null; }
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? [path, ...walk(path)] : [path];
  });
}

function checkSample(root, manifest, entry, report) {
  const id = entry?.sampleId;
  if (typeof id !== 'string' || !SAFE_NAME.test(id)) { report.error('manifest.json', '样本编号缺失或含非法字符'); return; }
  const dir = join(root, 'samples', id);
  const at = name => `samples/${id}/${name}`;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) { report.error(`samples/${id}`, '样本目录不存在'); return; }
  if (!existsSync(join(dir, 'checklist.md'))) report.error(at('checklist.md'), '缺少文件（§8 需退回）');

  const input = readJson(join(dir, 'input.json'), report, at('input.json'));
  const meta = readJson(join(dir, 'meta.json'), report, at('meta.json'));

  if (input) {
    if (input.specVersion !== '1') report.error(at('input.json'), 'specVersion 应为 "1"');
    if (input.sampleId !== id) report.error(at('input.json'), 'sampleId 与目录不一致');
    if (input.productCode !== manifest.productCode) report.error(at('input.json'), 'productCode 与 manifest 不一致');
    if (input.productVersion !== manifest.productVersion) report.error(at('input.json'), 'productVersion 与 manifest 不一致（同一批样本必须同一版本）');
    const params = input.params;
    if (!params || typeof params !== 'object' || Array.isArray(params) || !Object.keys(params).length) report.error(at('input.json'), 'params 为空或不是对象');
    else {
      for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) report.error(at('input.json'), `params.${key} 是小数；金额须用十进制定点字符串`);
        else if (typeof value === 'string' && /^\s*[-+]?\d+(\.\d+)?e[-+]?\d+\s*$/i.test(value)) report.error(at('input.json'), `params.${key} 使用了科学记数法`);
        else if (value === null && !(Array.isArray(meta?.knownIssues) && meta.knownIssues.length)) report.error(at('input.json'), `params.${key} 为 null，须在 meta.json knownIssues 中说明`);
        else if (value !== null && !['string', 'boolean', 'number'].includes(typeof value)) report.error(at('input.json'), `params.${key} 类型不支持`);
      }
      const entries = Array.isArray(input.portalEntries) ? input.portalEntries : null;
      if (!entries) report.error(at('input.json'), '缺少 portalEntries');
      else {
        const covered = new Set(entries.map(item => item?.fieldCode));
        for (const key of Object.keys(params)) if (!covered.has(key)) report.error(at('input.json'), `portalEntries 未覆盖字段 ${key}`);
        for (const item of entries) {
          if (!['entered', 'portal-default', 'script-default'].includes(item?.source)) report.error(at('input.json'), `portalEntries 字段 ${item?.fieldCode ?? '?'} 的 source 无效`);
        }
      }
    }
  }

  const pdfs = readdirSync(dir).filter(name => name.toLowerCase().endsWith('.pdf'));
  if (pdfs.length !== 1) { report.error(`samples/${id}`, `应有且只有 1 个 PDF，实际 ${pdfs.length} 个`); return; }
  const fileName = pdfs[0];
  const bytes = readFileSync(join(dir, fileName));
  const actualSha = sha256(bytes);
  const expectedName = `${id}__${manifest.productCode}__${safeVersion(manifest.productVersion)}.pdf`;
  if (fileName !== expectedName) report.warn(at(fileName), `文件名与规范不同，应为 ${expectedName}`);
  const structure = inspectPdfStructure(bytes);
  if (!structure.ok) report.error(at(fileName), `PDF 结构不合格：${structure.problem}${structure.detected ? `（内容像 ${structure.detected}）` : ''}`);
  if (entry.pdfSha256 !== actualSha) report.error('manifest.json', `${id} 的 pdfSha256 与文件不符`);

  if (meta) {
    if (meta.sampleId !== id) report.error(at('meta.json'), 'sampleId 与目录不一致');
    if (meta.product?.productVersion !== manifest.productVersion) report.error(at('meta.json'), 'product.productVersion 与 manifest 不一致');
    if (meta.pdf?.fileName !== fileName) report.error(at('meta.json'), 'pdf.fileName 与目录中的 PDF 不一致');
    if (meta.pdf?.sha256 !== actualSha) report.error(at('meta.json'), 'pdf.sha256 与文件不符');
    if (meta.pdf?.sizeBytes !== bytes.length) report.error(at('meta.json'), 'pdf.sizeBytes 与文件大小不符');
    if (meta.pdf?.passwordProtected !== false) report.error(at('meta.json'), 'PDF 须不加密（pdf.passwordProtected 应为 false）');
    if (meta.pdf?.textExtractable !== true) report.warn(at('meta.json'), 'pdf.textExtractable 不是 true，确定性核验可能无法进行');
    if (meta.desensitization?.modifiedPdf === true && meta.desensitization?.textLayerChecked !== true) report.error(at('meta.json'), '事后脱敏的 PDF 须确认已检查文字层');
    if (!meta.validity?.confirmedByRole) report.error(at('meta.json'), '缺少组合有效性确认人（validity.confirmedByRole）');
  }
}

export function checkSamplePackage(root) {
  const problems = [];
  const report = {
    error: (file, message) => problems.push({ level: 'error', file, message }),
    warn: (file, message) => problems.push({ level: 'warning', file, message }),
  };
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    report.error('.', '样本包目录不存在');
    return { ok: false, problems, samples: 0 };
  }
  for (const path of walk(root)) {
    const name = path.split(/[\\/]/).pop();
    if (!SAFE_NAME.test(name)) report.error(relative(root, path), '文件或目录名只能使用 ASCII 字母、数字和 - _ .');
  }
  const manifest = readJson(join(root, 'manifest.json'), report, 'manifest.json');
  if (!existsSync(join(root, 'README.md'))) report.warn('README.md', '缺少提交说明');
  if (!existsSync(join(root, 'product', 'field-map.md'))) report.error('product/field-map.md', '缺少字段映射表');
  let samples = 0;
  if (manifest) {
    for (const key of ['batchId', 'productCode', 'productVersion']) {
      if (typeof manifest[key] !== 'string' || !manifest[key].trim()) report.error('manifest.json', `缺少 ${key}`);
    }
    const list = Array.isArray(manifest.samples) ? manifest.samples : [];
    samples = list.length;
    if (!samples) report.error('manifest.json', '没有正样本');
    else if (samples < 3) report.warn('manifest.json', `正样本 ${samples} 组：可以开始编写规则，验收需要 3–5 组`);
    const ids = list.map(item => item?.sampleId);
    if (new Set(ids).size !== ids.length) report.error('manifest.json', '样本编号重复');
    for (const entry of list) checkSample(root, manifest, entry, report);
    for (const entry of Array.isArray(manifest.negative) ? manifest.negative : []) {
      const id = entry?.sampleId;
      if (typeof id !== 'string' || !SAFE_NAME.test(id) || !existsSync(join(root, 'negative', id, 'meta.json'))) {
        report.error(`negative/${id ?? '?'}`, '负样本目录或 meta.json 缺失');
      }
    }
  }
  return { ok: !problems.some(problem => problem.level === 'error'), problems, samples };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, flag] = process.argv.slice(2);
  if (!dir) { console.error('用法：node scripts/check-samples.mjs <样本包目录> [--json]'); process.exit(2); }
  const result = checkSamplePackage(dir);
  if (flag === '--json') console.log(JSON.stringify(result, null, 2));
  else {
    for (const { level, file, message } of result.problems) console.log(`${level === 'error' ? '错误' : '提醒'}  ${file}：${message}`);
    console.log(result.ok ? `通过：${result.samples} 组正样本结构完整。` : '未通过：请按 sample-spec.md §8 退回或修正。');
    console.log('逐字段核验：尚无该产品的确定性核验规则，须按各样本 checklist.md 编写后再运行。');
  }
  process.exit(result.ok ? 0 : 1);
}
