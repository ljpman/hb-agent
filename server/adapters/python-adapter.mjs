import { randomUUID } from 'node:crypto';
import { STATUS, ERROR } from './insurer-adapter.mjs';

// PythonInsurerAdapter — M1a skeleton for the authorized Hong Kong Python
// execution service (docs/python-integration-contract.md). It can build the
// contract request (§3) and map the contract result / error codes (§4, §5) onto
// the job state machine. It does NOT talk to any real portal yet and never
// claims a real insurer is supported.
//
// Deliberate M1a limits, per the project red lines:
//   * Without a configured endpoint it routes to manual (ADAPTER_NOT_CONFIGURED),
//     never falling back to the mock.
//   * A candidate file is only ever parked in `validating`. In validating the
//     adapter can only FETCH the bytes for the stored artifactRef (through an
//     injected, controlled `fetchArtifact`) and hand them back as a `candidate`.
//     The business Service runs the deterministic verifier; the adapter never
//     approves its own file. Without `fetchArtifact` the job goes to manual.
//   * Parameter errors are not retried; anything uncertain or portal-side goes
//     to manual. Transient errors are held for manual review rather than
//     blind-retried, because re-running a real portal task risks a duplicate.

// How each contract error code (§5) reacts. Non-retryable param errors fail so
// the broker re-confirms; everything else that is not clearly deliverable holds
// for manual handling.
const ERROR_OUTCOMES = {
  [ERROR.PARAM_INVALID]: { status: STATUS.failed, text: '参数需修改，请重新确认后再生成', error: ERROR.PARAM_INVALID },
  [ERROR.PRODUCT_UNAVAILABLE]: { status: STATUS.failed, text: '产品暂不可用，请稍后再试', error: ERROR.PRODUCT_UNAVAILABLE },
  [ERROR.AUTH_REQUIRED]: { status: STATUS.awaiting_manual, text: '需要重新登录，已转人工', error: ERROR.AUTH_REQUIRED },
  [ERROR.MFA_REQUIRED]: { status: STATUS.awaiting_manual, text: '需要人工处理多重验证', error: ERROR.MFA_REQUIRED },
  [ERROR.PORTAL_CHANGED]: { status: STATUS.awaiting_manual, text: '门户可能已变化，已暂停自动执行', error: ERROR.PORTAL_CHANGED },
  [ERROR.TRANSIENT_NETWORK_ERROR]: { status: STATUS.awaiting_manual, text: '暂时性故障，已转人工核实（骨架阶段不自动重试真实门户）', error: ERROR.TRANSIENT_NETWORK_ERROR },
  [ERROR.RESULT_UNKNOWN]: { status: STATUS.awaiting_manual, text: '结果未知，请先核对门户再处理', error: ERROR.RESULT_UNKNOWN },
  [ERROR.PDF_MISMATCH]: { status: STATUS.awaiting_manual, text: '文件核验失败，已阻止交付', error: ERROR.PDF_MISMATCH },
  [ERROR.WORKER_LOST]: { status: STATUS.awaiting_manual, text: '执行进程丢失，正在恢复／需人工', error: ERROR.WORKER_LOST },
};

async function fetchTransport(endpoint, request, { signal } = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
    redirect: 'error',
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

const reference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);

export class PythonInsurerAdapter {
  isMock = false;

  // fetchArtifact({ jobId, attemptId, artifactRef }, { signal }) → Buffer. How the
  // Hong Kong service serves files is not confirmed yet, so there is no default.
  constructor({ endpoint = null, transport = fetchTransport, fetchArtifact = null, contractVersion = '1', timeoutMs = 120000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new TypeError('timeoutMs must be a positive bounded integer');
    if (fetchArtifact !== null && typeof fetchArtifact !== 'function') throw new TypeError('fetchArtifact must be a function');
    this.endpoint = endpoint;
    this.transport = transport;
    this.fetchArtifact = fetchArtifact;
    this.contractVersion = contractVersion;
    this.timeoutMs = timeoutMs;
  }

  // Request envelope constructed by the business backend after confirmation and
  // authorization (docs/python-integration-contract.md §3). Credentials are
  // referenced by credentialRef only; no plaintext secret ever appears here.
  buildRequest(job) {
    return {
      contractVersion: this.contractVersion,
      jobId: job.id,
      attemptId: job.executionAttempt?.id ?? `${job.id}-attempt-${randomUUID()}`,
      productId: job.productId,
      productVersion: job.productVersion,
      schemaVersion: job.schemaVersion,
      confirmationRef: job.draftId,
      paramsHash: job.paramsHash,
      params: job.params,
      credentialRef: job.credentialRef ?? null,
      deadlineAt: new Date(Date.now() + this.timeoutMs).toISOString(),
    };
  }

  // Bound even injected calls that ignore AbortSignal. An aborted local call does
  // not prove the remote side stopped, so callers treat any failure as unknown.
  async bounded(call, signal) {
    const controller = new AbortController();
    let timer, cancel;
    try {
      return await Promise.race([
        Promise.resolve().then(() => call(controller.signal)),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('Execution deadline exceeded')); }, this.timeoutMs);
        }),
        new Promise((_, reject) => {
          cancel = () => { controller.abort(); reject(new Error('Execution lease lost')); };
          if (signal?.aborted) cancel();
          else signal?.addEventListener('abort', cancel, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (cancel) signal?.removeEventListener('abort', cancel);
    }
  }

  async advance(job, { signal } = {}) {
    if (!this.endpoint) {
      return { kind: 'transition', status: STATUS.awaiting_manual, text: '真实执行服务尚未配置', error: ERROR.ADAPTER_NOT_CONFIGURED };
    }
    if (job.status === STATUS.queued) {
      return { kind: 'transition', status: STATUS.running, text: '正在调用授权执行服务' };
    }
    if (job.status === STATUS.running) {
      let result;
      const request = this.buildRequest(job);
      try {
        // An uncertain submission is never retried automatically, including a late response.
        result = await this.bounded(abort => this.transport(this.endpoint, request, { signal: abort }), signal);
      } catch {
        // Uncertain result: do not blindly retry a real portal task.
        return { kind: 'transition', status: STATUS.awaiting_manual, text: '调用执行服务失败，结果未知，转人工核实', error: ERROR.RESULT_UNKNOWN };
      }
      // A real service must never silently hand back a mock result.
      if (result && result.isMock === true) {
        return { kind: 'transition', status: STATUS.awaiting_manual, text: '真实执行服务返回了模拟标识，已阻止交付', error: ERROR.ADAPTER_MISMATCH };
      }
      // Bind every response (including errors) to this exact submission before
      // using it. Never persist arbitrary remote metadata, messages or URLs.
      const unknown = { kind: 'transition', status: STATUS.awaiting_manual, text: '执行结果无法与本次任务可靠对应，转人工核实', error: ERROR.RESULT_UNKNOWN };
      if (!result || Array.isArray(result) || result.jobId !== request.jobId || result.attemptId !== request.attemptId || result.isMock !== false) return unknown;
      if (result.error) {
        const mapped = Object.hasOwn(ERROR_OUTCOMES, result.error) ? ERROR_OUTCOMES[result.error] : ERROR_OUTCOMES[ERROR.RESULT_UNKNOWN];
        return { kind: 'transition', ...mapped };
      }
      const source = result.source;
      if (result.status !== STATUS.validating || !reference(result.artifactRef) || !source ||
          !reference(source.insurerId) || source.productId !== job.productId || source.productVersion !== job.productVersion ||
          (job.execution?.insurerId && source.insurerId !== job.execution.insurerId)) return unknown;
      // Candidate obtained but not yet verifiable → hold in validating and keep
      // the official source / validation metadata for review.
      return {
        kind: 'transition',
        status: STATUS.validating,
        text: '已取得候选文件，等待核验',
        patch: {
          source: { insurerId: source.insurerId, productId: source.productId, productVersion: source.productVersion },
          validation: { status: 'pending', mismatches: [] },
          artifactRef: result.artifactRef,
        },
      };
    }
    // validating: fetch the candidate for the stored reference only. The Service
    // verifies it against the confirmed snapshot; this adapter cannot succeed a job.
    const unknown = { kind: 'transition', status: STATUS.awaiting_manual, text: '候选文件无法可靠取回，转人工核实', error: ERROR.RESULT_UNKNOWN };
    if (!this.fetchArtifact) {
      return { kind: 'transition', status: STATUS.awaiting_manual, text: '真实文件取回与核验尚未接入，转人工核对', error: ERROR.RESULT_UNKNOWN };
    }
    if (!reference(job.artifactRef) || !job.executionAttempt?.id) return unknown;
    let bytes;
    try {
      bytes = await this.bounded(abort => this.fetchArtifact({ jobId: job.id, attemptId: job.executionAttempt.id, artifactRef: job.artifactRef }, { signal: abort }), signal);
    } catch { return unknown; }
    if (bytes instanceof Uint8Array && !Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    if (!Buffer.isBuffer(bytes)) return unknown;
    return { kind: 'candidate', artifactRef: job.artifactRef, bytes, text: '已取回候选文件，等待业务服务核验' };
  }
}
