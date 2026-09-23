import { createHash } from 'node:crypto';

// Deterministic verification of a real candidate file against the broker's
// confirmed snapshot (AGENTS.md §2 red lines 1 and 5; docs/insurance-agent-v2.md
// §6.5). The business Service owns this step: an adapter may fetch a candidate
// file, but it can never approve its own result.
//
// Two layers:
//   1. inspectPdfStructure — product-independent checks decided by file content,
//      never by extension: non-empty, bounded size, PDF header, not truncated,
//      not encrypted. HTML login pages, images and archives fail here.
//   2. Product rules — one rule set per (productId, productVersion), written from
//      the signed sample checklists. A rule only LOCATES values in the PDF
//      (`extract`); this module normalizes and compares them with the confirmed
//      params, so a rule cannot choose what counts as "expected".
//
// Every confirmed field plus the product version must be located, with a page,
// and must match. Anything missing, unparseable or thrown is `unverifiable` and
// goes to manual; a located value that differs is `mismatch`. Evidence records
// which field matched on which page, never the values read from the PDF, so no
// unverified number from a document leaves this module.
//
// No product rules exist yet: real samples have not arrived (M1b). Until a rule
// set is registered, every real candidate is `unverifiable`.

export const VERIFY = Object.freeze({ passed: 'passed', mismatch: 'mismatch', unverifiable: 'unverifiable' });
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function sniff(bytes) {
  const head = bytes.subarray(0, 512).toString('latin1');
  if (/^\s*<(!doctype|html|head|body|\?xml)/i.test(head)) return 'html';
  if (head.startsWith('PK\x03\x04')) return 'zip';
  if (head.startsWith('\x89PNG') || head.startsWith('\xFF\xD8\xFF') || head.startsWith('GIF8')) return 'image';
  return 'unknown';
}

export function inspectPdfStructure(bytes, { maxBytes = MAX_PDF_BYTES } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, problem: 'EMPTY' };
  if (bytes.length > maxBytes) return { ok: false, problem: 'TOO_LARGE' };
  if (!/^%PDF-(1\.[0-7]|2\.0)/.test(bytes.subarray(0, 16).toString('latin1'))) return { ok: false, problem: 'NOT_PDF', detected: sniff(bytes) };
  if (!bytes.subarray(Math.max(0, bytes.length - 2048)).includes('%%EOF')) return { ok: false, problem: 'TRUNCATED' };
  // Encrypted files cannot be parsed reliably; a false positive only means manual review.
  if (bytes.includes('/Encrypt')) return { ok: false, problem: 'ENCRYPTED' };
  return { ok: true };
}

function decimal(raw) {
  if (typeof raw !== 'string') return undefined;
  let text = raw.trim();
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(text)) text = text.replaceAll(',', '');
  if (!/^\d{1,15}(\.\d{1,2})?$/.test(text)) return undefined;
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

// Normalizes a located PDF value to the same form Service.validate() stores.
function normalize(field, raw) {
  if (field.type === 'integer') {
    if (Number.isSafeInteger(raw)) return raw;
    return typeof raw === 'string' && /^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
  }
  if (field.type === 'boolean') return typeof raw === 'boolean' ? raw : undefined;
  if (field.type === 'enum') return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  if (field.type === 'decimal') return decimal(raw);
  return undefined;
}

const located = entry => entry && typeof entry === 'object' && Object.hasOwn(entry, 'value') &&
  Number.isSafeInteger(entry.page) && entry.page > 0;

export function createPdfVerifier({ rules = [], maxBytes = MAX_PDF_BYTES } = {}) {
  const registry = new Map();
  for (const rule of rules) {
    if (!rule || typeof rule.productId !== 'string' || typeof rule.productVersion !== 'string' || typeof rule.extract !== 'function') {
      throw new TypeError('A verification rule needs productId, productVersion and extract()');
    }
    const key = `${rule.productId}@${rule.productVersion}`;
    if (registry.has(key)) throw new TypeError(`Duplicate verification rule for ${key}`);
    registry.set(key, rule);
  }

  return {
    hasRules(job) { return registry.has(`${job?.productId}@${job?.productVersion}`); },

    // Returns { status, fileSha256, ruleSet, problem, checks: [{ field, page, match }] }.
    async verify({ bytes, job }) {
      const result = (status, extra = {}) => ({ status, fileSha256: Buffer.isBuffer(bytes) ? sha256(bytes) : null, ruleSet: null, problem: null, checks: [], ...extra });
      const structure = inspectPdfStructure(bytes, { maxBytes });
      if (!structure.ok) return result(VERIFY.mismatch, { problem: structure.problem });
      const ruleSet = `${job?.productId}@${job?.productVersion}`;
      const rule = registry.get(ruleSet);
      if (!rule) return result(VERIFY.unverifiable, { problem: 'NO_RULES' });
      const fields = job.productSnapshot?.fields;
      if (!Array.isArray(fields) || fields.length === 0 || !job.params) return result(VERIFY.unverifiable, { ruleSet, problem: 'NO_SNAPSHOT' });

      let found;
      try { found = await rule.extract({ bytes: Buffer.from(bytes), job: structuredClone(job) }); }
      catch { return result(VERIFY.unverifiable, { ruleSet, problem: 'EXTRACT_FAILED' }); }
      if (!found || typeof found !== 'object' || !located(found.productVersion) || !found.fields || typeof found.fields !== 'object') {
        return result(VERIFY.unverifiable, { ruleSet, problem: 'INCOMPLETE' });
      }

      const checks = [];
      const version = found.productVersion;
      if (typeof version.value !== 'string') return result(VERIFY.unverifiable, { ruleSet, problem: 'UNPARSEABLE' });
      checks.push({ field: 'productVersion', page: version.page, match: version.value.trim() === job.productVersion });
      for (const field of fields) {
        const entry = Object.hasOwn(found.fields, field.key) ? found.fields[field.key] : null;
        if (!located(entry)) return result(VERIFY.unverifiable, { ruleSet, problem: 'INCOMPLETE' });
        const value = normalize(field, entry.value);
        if (value === undefined) return result(VERIFY.unverifiable, { ruleSet, problem: 'UNPARSEABLE' });
        checks.push({ field: field.key, page: entry.page, match: value === job.params[field.key] });
      }
      return result(checks.every(check => check.match) ? VERIFY.passed : VERIFY.mismatch, { ruleSet, checks });
    },
  };
}
