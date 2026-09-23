import { randomUUID, createHash } from 'node:crypto';

export const COMPLIANCE_VERSION = 'm2a2-3';

// Tool/model prose has no verified numerical evidence in the offline milestone.
// Chinese financial quantities can omit a currency/unit (e.g. 保额为壹佰萬),
// so matching only Arabic digits or a small currency suffix list is insufficient.
export function hasUnverifiedNumber(text) {
  const normalized = text.normalize('NFKC');
  const chineseNumber = /[零〇一二三四五六七八九十百千万萬亿億两兩壹贰貳叁參肆伍陆陸柒捌玖拾佰仟]/;
  const financialContext = /收益|回报|回報|现金|現金|利益|红利|紅利|分红|分紅|派息|退保|保费|保費|保额|保額|保障金额|保障金額|赔偿|賠償|理赔|理賠|缴|繳|交费|交費|premium|cash\s*value|benefit|return|coverage|IRR/i;
  return /\p{N}|[%％]|百分之/u.test(normalized)
    || (financialContext.test(normalized) && chineseNumber.test(normalized))
    || /[零〇一二三四五六七八九十百千万萬亿億两兩壹贰貳叁參肆伍陆陸柒捌玖拾佰仟]+\s*(?:元|美元|港元|美金|港币|港幣|万|萬|成|倍|厘)/.test(normalized);
}

// Deterministic output guard — the last gate before any reply leaves the backend.
// Red line: output review happens BEFORE sending (a reply streamed out and scanned
// afterwards cannot be retracted). This layer never invents or rewrites content; it
// only decides allow/block. Semantic rewrite needs a model and is deferred to M2b.
//
// This is where "the model never emits any insurance amount / benefit number" is
// enforced at the exit: a benefit/return figure with no citation is blocked.

export const COMPLIANCE_RULES = {
  PROMISE: 'promise-language',
  UNSOURCED_NUMBER: 'unsourced-benefit-number',
  SENSITIVE: 'sensitive-data',
};

// Absolute / guaranteed-return sales language that is never allowed.
const PROMISE_RE = /(保证|确保|包).{0,4}(赚|回报|收益|升值|回本|盈利|赢)|稳赚|稳赢|绝对安全|零风险|毫无风险|一定.{0,3}(赚|涨|回本|升值)|包赚|旱涝保收/;
// A benefit / return / cash-value claim…
const BENEFIT_CONTEXT_RE = /(收益|回报|回报率|现金价值|保证利益|非保证利益|红利|分红|派息|内部回报率|IRR|收益率|预期回报|退保价值)/;
// …carrying a number, or a bare return percentage anywhere.
const NUMBER_RE = /\d+(?:\.\d+)?\s*(?:%|％|万|元|美元|港[币元]|USD|HKD)?/;
const BARE_PERCENT_RE = /\d+(?:\.\d+)?\s*[%％]/;
// Obvious sensitive identifiers / secrets that must never appear in a reply.
const SENSITIVE_RE = /\b\d{17}[\dXx]\b|password\s*[:=]|cookie\s*[:=]|api[_-]?key|bearer\s+[A-Za-z0-9._-]{10,}/i;

// Hong Kong Identity Card number: 1–2 letters + 6 digits + check character
// (0–9 or A). The check character may sit in half-width () or full-width （）
// brackets, or be written without brackets. Text is NFKC-normalised first, so
// full-width letters/digits/brackets are covered too.
//   * Bracketed form: letters in either case (the brackets are a strong signal).
//   * Bare form: upper-case letters only, bounded by non-alphanumerics, so
//     lower-case hex/UUID fragments and longer codes are not read as an HKID.
// Only a candidate whose check character satisfies the mod-11 checksum counts.
// That removes ~10/11 of same-shaped product codes / policy numbers; the rest
// fail closed (reply goes to manual review), which is the safe direction.
const HKID_BRACKETED_RE = /(?<![A-Za-z0-9])([A-Za-z]{1,2})(\d{6})[ ]?\(([0-9Aa])\)/g;
const HKID_BARE_RE = /(?<![A-Za-z0-9])([A-Z]{1,2})(\d{6})([0-9A])(?![A-Za-z0-9])/g;

// Check character for an HKID body. Letters are A=10 … Z=35; a single-letter
// prefix is padded with a leading space valued 36. Weights 9..2 over the eight
// positions; check = (11 − sum mod 11) mod 11, where 10 is written "A".
export function hkidCheckCharacter(prefix, digits) {
  const letters = String(prefix).toUpperCase();
  if (!/^[A-Z]{1,2}$/.test(letters) || !/^\d{6}$/.test(String(digits))) return null;
  const values = [...letters.padStart(2, ' ')].map(c => (c === ' ' ? 36 : c.charCodeAt(0) - 55))
    .concat([...String(digits)].map(Number));
  const sum = values.reduce((total, value, i) => total + value * (9 - i), 0);
  const check = (11 - (sum % 11)) % 11;
  return check === 10 ? 'A' : String(check);
}

export function containsHkid(text) {
  const normalized = String(text ?? '').normalize('NFKC');
  for (const pattern of [HKID_BRACKETED_RE, HKID_BARE_RE]) {
    for (const match of normalized.matchAll(pattern)) {
      if (hkidCheckCharacter(match[1], match[2]) === match[3].toUpperCase()) return true;
    }
  }
  return false;
}

export function containsSensitive(text) {
  const raw = String(text ?? '');
  // Raw and NFKC forms are both checked so normalisation can only add matches.
  return SENSITIVE_RE.test(raw) || SENSITIVE_RE.test(raw.normalize('NFKC')) || containsHkid(raw);
}

const sha = value => createHash('sha256').update(String(value ?? '')).digest('hex');

// Evaluate one outgoing reply. `citations` is the list of sources backing the
// reply; product facts and numbers are only allowed when something backs them.
export function evaluateCompliance({ text = '', citations = [] } = {}) {
  const rules = [];
  const hasCitation = Array.isArray(citations) && citations.filter(Boolean).length > 0;

  if (PROMISE_RE.test(text)) rules.push(COMPLIANCE_RULES.PROMISE);
  if (!hasCitation && ((BENEFIT_CONTEXT_RE.test(text) && NUMBER_RE.test(text)) || BARE_PERCENT_RE.test(text))) {
    rules.push(COMPLIANCE_RULES.UNSOURCED_NUMBER);
  }
  if (containsSensitive(text)) rules.push(COMPLIANCE_RULES.SENSITIVE);

  const decision = rules.length > 0 ? 'block' : 'allow';
  return {
    decision,
    rules,
    auditId: `cmp-${randomUUID()}`,
    sourceHash: sha((Array.isArray(citations) ? citations : []).join('|')),
    replyHash: sha(text),
  };
}
