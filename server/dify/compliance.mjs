import { randomUUID, createHash } from 'node:crypto';

export const COMPLIANCE_VERSION = 'm2a2-1';

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
  if (SENSITIVE_RE.test(text)) rules.push(COMPLIANCE_RULES.SENSITIVE);

  const decision = rules.length > 0 ? 'block' : 'allow';
  return {
    decision,
    rules,
    auditId: `cmp-${randomUUID()}`,
    sourceHash: sha((Array.isArray(citations) ? citations : []).join('|')),
    replyHash: sha(text),
  };
}
