// InsurerAdapter contract (docs/insurance-agent-v2.md §6.5 and
// docs/python-integration-contract.md). An adapter drives one job forward by a
// single step and reports the outcome; the business Service owns identity,
// authorization, idempotency, the confirmed snapshot and the state machine.
//
// The model never generates insurance amounts, returns, cash values or premiums.
// Numbers only come from broker-confirmed inputs echoed back, or from an official
// PDF verified deterministically. When a real artifact cannot be reliably
// verified, an adapter routes the job to manual instead of delivering it.
//
// Adapter surface:
//   isMock: boolean                       — must match the job's persisted isMock
//   advance(job, ctx): Promise<Outcome>   — advance one step from job.status
//
// ctx: { pdf, signal } — pdf(job) renders the demo; signal aborts on lease loss.
// job.executionAttempt is durably recorded before a real running step executes.
//
// Outcome is a plain, serializable description the Service applies; adapters do
// not mutate the store directly:
//   { kind: 'transition', status, text, error?, patch? }
//   { kind: 'artifact', bytes, text }     — demonstration only: mock jobs may succeed
//   { kind: 'candidate', artifactRef, bytes, text }
//                                         — real jobs: bytes fetched for the stored
//                                           artifactRef; the Service verifies them
//
// `patch` only permits source, validation and artifactRef metadata. Identity,
// confirmation and execution fields cannot be replaced by adapter results.
// The Service validates transitions and commits status, audit and file together.
// A real job succeeds only when the Service's deterministic verifier
// (server/verify/pdf-verifier.mjs) passes the candidate against the confirmed
// snapshot. No product rules exist yet, so real candidates still go to manual.

// Status vocabulary shared across adapters and the Service state machine.
export const STATUS = Object.freeze({
  queued: 'queued',
  running: 'running',
  validating: 'validating',
  succeeded: 'succeeded',
  awaiting_manual: 'awaiting_manual',
  failed: 'failed',
});

// Structured error codes (docs/python-integration-contract.md §5) plus the two
// this project adds for honest mock/real separation.
export const ERROR = Object.freeze({
  PARAM_INVALID: 'PARAM_INVALID',
  PRODUCT_UNAVAILABLE: 'PRODUCT_UNAVAILABLE',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  PORTAL_CHANGED: 'PORTAL_CHANGED',
  TRANSIENT_NETWORK_ERROR: 'TRANSIENT_NETWORK_ERROR',
  RESULT_UNKNOWN: 'RESULT_UNKNOWN',
  PDF_MISMATCH: 'PDF_MISMATCH',
  WORKER_LOST: 'WORKER_LOST',
  // Real execution service is not wired for this product yet (M1b).
  ADAPTER_NOT_CONFIGURED: 'ADAPTER_NOT_CONFIGURED',
  // Adapter/job mock flags disagree, or a real service returned a mock result.
  ADAPTER_MISMATCH: 'ADAPTER_MISMATCH',
});
