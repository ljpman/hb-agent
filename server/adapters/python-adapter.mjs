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
//   * A candidate file is only ever parked in `validating`. Deterministic PDF
//     verification against the confirmed snapshot needs real fields and sample
//     PDFs, which arrive in M1b — so this skeleton never auto-delivers a real
//     file (validating → manual with RESULT_UNKNOWN).
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

async function fetchTransport(endpoint, request) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export class PythonInsurerAdapter {
  isMock = false;

  constructor({ endpoint = null, transport = fetchTransport, contractVersion = '1', timeoutMs = 120000 } = {}) {
    this.endpoint = endpoint;
    this.transport = transport;
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
      attemptId: `${job.id}-attempt-${randomUUID()}`,
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

  async advance(job) {
    if (!this.endpoint) {
      return { kind: 'transition', status: STATUS.awaiting_manual, text: '真实执行服务尚未配置', error: ERROR.ADAPTER_NOT_CONFIGURED };
    }
    if (job.status === STATUS.queued) {
      return { kind: 'transition', status: STATUS.running, text: '正在调用授权执行服务' };
    }
    if (job.status === STATUS.running) {
      let result;
      try {
        result = await this.transport(this.endpoint, this.buildRequest(job));
      } catch {
        // Uncertain result: do not blindly retry a real portal task.
        return { kind: 'transition', status: STATUS.awaiting_manual, text: '调用执行服务失败，结果未知，转人工核实', error: ERROR.RESULT_UNKNOWN };
      }
      if (result && result.error) {
        const mapped = ERROR_OUTCOMES[result.error] ?? { status: STATUS.awaiting_manual, text: '未知错误，已转人工', error: ERROR.RESULT_UNKNOWN };
        return { kind: 'transition', ...mapped };
      }
      // A real service must never silently hand back a mock result.
      if (result && result.isMock === true) {
        return { kind: 'transition', status: STATUS.awaiting_manual, text: '真实执行服务返回了模拟标识，已阻止交付', error: ERROR.ADAPTER_MISMATCH };
      }
      // Candidate obtained but not yet verifiable → hold in validating and keep
      // the official source / validation metadata for review.
      return {
        kind: 'transition',
        status: STATUS.validating,
        text: '已取得候选文件，等待核验',
        patch: {
          source: result?.source ?? null,
          validation: result?.validation ?? null,
          artifactRef: result?.artifactRef ?? null,
        },
      };
    }
    // validating: deterministic verification against the confirmed snapshot is
    // deferred to M1b (needs real fields + sample PDFs). Never auto-succeed.
    return { kind: 'transition', status: STATUS.awaiting_manual, text: '真实文件核验规则尚未接入，转人工核对', error: ERROR.RESULT_UNKNOWN };
  }
}
