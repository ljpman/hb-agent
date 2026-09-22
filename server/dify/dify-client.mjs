import { LocalFallbackDifyClient } from './local-fallback.mjs';

// DifyClient — the backend's seam to the Dify channel app (docs/dify-workflow-plan.md).
//
// Red lines this seam enforces:
//   * The Dify API Key lives ONLY in the backend, and travels in the Authorization
//     header, never in the request body/inputs or anywhere the client can see.
//   * Identity and data scope stay in the business backend (the Service), never
//     delegated to the prompt. `user` is a backend-maintained internal id, not a
//     client-supplied value.
//   * When Dify is not configured, the backend falls back to a deliberately
//     limited local engine and says so honestly — it never pretends it called a
//     model.
//
// Interface: extractParams({ text, product, user? }), chat({ text, product, user? }),
//            isConfigured, status().

async function fetchTransport(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

// M2b skeleton — wired only when a real Dify instance + DeepSeek key are provided.
// It shapes the Dify API requests correctly (key in header, user from the backend)
// but does not claim to have validated any real workflow yet.
export class HttpDifyClient {
  isConfigured = true;

  constructor({ apiUrl, apiKey, transport = fetchTransport }) {
    this.apiUrl = String(apiUrl).replace(/\/$/, '');
    this.apiKey = apiKey;
    this.transport = transport;
  }

  headers() { return { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' }; }

  status() { return { dify: 'configured' }; }

  async chat({ text, user }) {
    const out = await this.transport(`${this.apiUrl}/chat-messages`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ inputs: {}, query: text, user, response_mode: 'blocking' }),
    });
    return { kind: out?.metadata?.intent || 'answer', answer: out?.answer ?? '', source: out?.metadata?.source ?? null, engine: 'dify' };
  }

  async extractParams({ text, product, user }) {
    const out = await this.transport(`${this.apiUrl}/workflows/run`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ inputs: { product_id: product.id, schema_version: product.schemaVersion, text }, user, response_mode: 'blocking' }),
    });
    const data = out?.data?.outputs ?? {};
    return { params: data.params ?? {}, evidence: data.evidence ?? {}, conflicts: data.conflicts ?? [], missing: data.missing ?? [], isMock: false, engine: 'dify' };
  }
}

export function createDifyClient({ apiUrl = null, apiKey = null, transport } = {}) {
  if (apiUrl && apiKey) return new HttpDifyClient({ apiUrl, apiKey, ...(transport ? { transport } : {}) });
  return new LocalFallbackDifyClient();
}
