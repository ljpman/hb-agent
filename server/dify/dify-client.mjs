import { AppError } from '../errors.mjs';
import { evaluateCompliance, hasUnverifiedNumber } from './compliance.mjs';
import { LocalFallbackDifyClient } from './local-fallback.mjs';

// DifyClient — the backend's seam to the Dify apps (docs/dify-workflow-plan.md).
//
// Red lines this seam enforces:
//   * Dify issues one API key PER APP. Each capability uses only its own app's
//     key; a missing key makes that capability report "not configured" — another
//     app's key is never substituted, and one key may not be shared by two apps.
//   * Keys live ONLY in the backend (private fields), travel only in the
//     Authorization header, and never appear in request bodies/inputs, status(),
//     error messages, or anything the client can see.
//   * Identity and data scope stay in the business backend (the Service), never
//     delegated to the prompt. `user` is a backend-maintained internal id, not a
//     client-supplied value, and is required on every call.
//   * Calls use blocking mode, so the backend has the complete reply before the
//     exit compliance guard runs; nothing is streamed onward unreviewed.
//   * When Dify is not configured, the backend falls back to a deliberately
//     limited local engine and says so honestly — it never pretends it called a
//     model. A failed remote call is an error, never a local result labelled Dify.
//
// Interface: chat({ text, product, user }), extractParams({ text, product, user }),
//            reviewCompliance({ draftReply, intent?, productId?, channel?, user }),
//            isConfigured, status().

// Capability → Dify app (docs/dify-workflow-plan.md).
export const DIFY_APPS = Object.freeze({
  chat: 'broker_assistant_chat',
  extract: 'proposal_extract',
  compliance: 'compliance_guard',
});
// Environment variable names reserved for M2b. The default and strict application
// modes reject every name in DIFY_ENV_VARS; only explicit localhost dev mode accepts them.
export const DIFY_APP_KEY_ENV = Object.freeze({
  chat: 'DIFY_CHAT_API_KEY',
  extract: 'DIFY_EXTRACT_API_KEY',
  compliance: 'DIFY_COMPLIANCE_API_KEY',
});
export const DIFY_ENV_VARS = Object.freeze(['DIFY_API_URL', 'DIFY_API_KEY', ...Object.values(DIFY_APP_KEY_ENV)]);

const notConfigured = app => new AppError(503, 'DIFY_APP_NOT_CONFIGURED', `Dify 应用 ${DIFY_APPS[app]} 未配置，该能力暂不可用，未调用 Dify。`);
const validUser = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
function inferIntent(text) {
  const query = String(text ?? '').normalize('NFKC');
  if (/进度|進度|任务状态|任務狀態|保单进展|保單進展/.test(query)) return 'progress';
  if (/提醒|跟进|跟進|回访|回訪|联系|聯絡|联络/.test(query)) return 'followup';
  if (/计划书|計劃書|建议书|建議書|出计划|出計劃|生成计划|生成計劃|直接(?:帮我)?提交|提交并忽略|马上生成/.test(query)) return 'proposal';
  if (/条款|條款|投保|保费|保費|现金价值|現金價值|退保价值|退保價值|保障|收益|回报|回報|产品|產品/.test(query)) return 'knowledge';
  return null;
}

async function fetchTransport(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

// Validates configuration without ever echoing a key value into an error.
function normalizeKeys(apiKeys) {
  if (!apiKeys || typeof apiKeys !== 'object' || Array.isArray(apiKeys)) throw new AppError(500, 'DIFY_CONFIG_INVALID', 'Dify 应用密钥配置格式无效。');
  const unknown = Object.keys(apiKeys).filter(app => !Object.hasOwn(DIFY_APPS, app));
  if (unknown.length) throw new AppError(500, 'DIFY_CONFIG_INVALID', `未知的 Dify 应用：${unknown.join('、')}。`);
  const keys = new Map();
  for (const app of Object.keys(DIFY_APPS)) {
    const key = apiKeys[app];
    if (key === undefined || key === null || key === '') continue;
    if (typeof key !== 'string' || !/^[\x21-\x7e]{8,256}$/.test(key)) throw new AppError(500, 'DIFY_CONFIG_INVALID', `Dify 应用 ${DIFY_APPS[app]} 的密钥格式无效。`);
    keys.set(app, key);
  }
  if (new Set(keys.values()).size !== keys.size) throw new AppError(500, 'DIFY_KEY_REUSED', '同一个 Dify API key 不能用于多个应用，请为每个应用配置各自的密钥。');
  return keys;
}

// M2b skeleton — wired only when a real Dify instance + DeepSeek + per-app keys are
// provided. It shapes the Dify API requests correctly but does not claim to have
// validated any real workflow yet. Contract tests inject an offline transport.
export class HttpDifyClient {
  isConfigured = true;
  #keys;

  constructor({ apiUrl, apiKeys, transport = fetchTransport, timeoutMs = 20000 }) {
    this.apiUrl = String(apiUrl).replace(/\/$/, '');
    this.#keys = normalizeKeys(apiKeys);
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }

  status() {
    const apps = Object.fromEntries(Object.keys(DIFY_APPS).map(app => [app, this.#keys.has(app) ? 'configured' : 'not-configured']));
    const configured = Object.values(apps).filter(state => state === 'configured').length;
    return { dify: configured === Object.keys(DIFY_APPS).length ? 'configured' : 'partially-configured', apps };
  }

  async #run(app, path, user, body) {
    const key = this.#keys.get(app);
    if (!key) throw notConfigured(app);
    if (!validUser(user)) throw new AppError(500, 'DIFY_USER_REQUIRED', '缺少后端维护的 Dify user 标识，未调用 Dify。');
    try {
      return await this.transport(`${this.apiUrl}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, user, response_mode: 'blocking' }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Never echo the transport error: it is not shown to users and must not carry
      // request details. The caller reports failure honestly instead of an answer.
      throw new AppError(502, 'DIFY_UNAVAILABLE', 'Dify 暂不可用，未获得回复，请稍后重试或转人工处理。');
    }
  }

  async chat({ text, user, conversation_id = null }) {
    const out = await this.#run('chat', '/chat-messages', user, {
      inputs: {}, query: text, ...(typeof conversation_id === 'string' ? { conversation_id } : {}),
    });
    if (typeof out?.answer !== 'string' || !out.answer.trim() || out.answer.length > 6000) {
      throw new AppError(502, 'DIFY_RESULT_INVALID', 'Dify 助手结果不可核实，请人工处理。');
    }
    let answer = out.answer;
    let modelIntent = null;
    try {
      const envelope = JSON.parse(out.answer);
      if (envelope && typeof envelope.answer === 'string' && envelope.answer.trim() && envelope.answer.length <= 3000) {
        answer = envelope.answer;
        modelIntent = envelope.metadata?.intent;
      }
    } catch { /* A plain-text answer remains subject to the backend exit guard. */ }
    // The Dify workflow may label a clear request as `unknown`. Preserve the
    // stable API taxonomy for unambiguous intents using a backend rule; only use
    // the model label where the backend has no matching rule.
    let intent = inferIntent(text) || modelIntent;
    if (!['proposal', 'progress', 'followup', 'knowledge', 'unknown'].includes(intent)) intent = 'unknown';
    // No knowledge base is configured in the M2b dev edition. Do not expose a
    // model-generated product-fact answer even if the prompt is ignored.
    if (intent === 'knowledge') answer = '当前没有已核验知识库，无法核实该产品事实，请以保司官方条款为准并由经纪核对。';
    // The M2b workspace has no verified knowledge base. Ignore all model-supplied
    // citation/source claims; only a later M3 retrieval validator may populate it.
    const metadata = { intent, source: null };
    const difyConversationId = typeof out.conversation_id === 'string' && /^[\w-]{1,100}$/.test(out.conversation_id) ? out.conversation_id : null;
    return { kind: intent, answer, source: null, metadata, engine: 'dify', difyConversationId };
  }

  async extractParams({ text, product, user }) {
    const out = await this.#run('extract', '/workflows/run', user, { inputs: { product_id: product.id, schema_version: product.schemaVersion, text } });
    const data = out?.data?.outputs ?? {};
    return { params: data.params ?? {}, evidence: data.evidence ?? {}, conflicts: data.conflicts ?? [], missing: data.missing ?? [], requiresConfirmation: true, isMock: false, engine: 'dify' };
  }

  // compliance_guard semantic review. ADVISORY ONLY: the caller must still apply
  // the deterministic exit guard (saveCompliance) and may only tighten its result.
  // Anything unknown, malformed or unavailable fails closed to `block`; a rewrite
  // is re-checked by the deterministic rules without trusting model citations.
  async reviewCompliance({ draftReply, intent = 'answer', productId = null, channel = 'app', user }) {
    let out;
    try {
      out = await this.#run('compliance', '/workflows/run', user, { inputs: { draft_reply: draftReply, intent, product_id: productId, channel } });
    } catch (error) {
      if (error.code !== 'DIFY_UNAVAILABLE') throw error;
      return { decision: 'block', rules: ['semantic-review-unavailable'], reply: null, engine: 'dify' };
    }
    const data = out?.data?.outputs ?? {};
    const rules = Array.isArray(data.rules) ? data.rules.filter(rule => typeof rule === 'string' && /^[\w-]{1,64}$/.test(rule)).slice(0, 20) : [];
    if (data.decision === 'allow') return { decision: 'allow', rules, reply: null, engine: 'dify' };
    if (data.decision === 'rewrite') {
      const reply = data.reply;
      const valid = typeof reply === 'string' && reply.trim() && reply.length <= 3000;
      const recheck = valid ? evaluateCompliance({ text: reply, citations: [] }) : null;
      if (valid && recheck.decision === 'allow' && !hasUnverifiedNumber(reply)) return { decision: 'rewrite', rules, reply, engine: 'dify' };
      return { decision: 'block', rules: [...rules, ...(recheck?.rules ?? []), 'rewrite-rejected'], reply: null, engine: 'dify' };
    }
    return { decision: 'block', rules: data.decision === 'block' ? rules : [...rules, 'semantic-review-invalid'], reply: null, engine: 'dify' };
  }
}

// `apiKeys` maps capability → that app's own key, e.g. { chat, extract, compliance }.
// A single shared `apiKey` is refused: it would silently stand in for other apps.
export function createDifyClient({ apiUrl = null, apiKeys = null, apiKey = null, transport, timeoutMs } = {}) {
  if (apiKey) throw new AppError(500, 'DIFY_KEY_AMBIGUOUS', '不接受单一 Dify API key；请按应用分别配置 chat／extract／compliance 密钥。');
  const anyKey = apiKeys && typeof apiKeys === 'object' && Object.values(apiKeys).some(Boolean);
  if (apiUrl && anyKey) return new HttpDifyClient({ apiUrl, apiKeys, ...(transport ? { transport } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  return new LocalFallbackDifyClient();
}
