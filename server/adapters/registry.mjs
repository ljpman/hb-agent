import { AppError } from '../errors.mjs';
import { MockInsurerAdapter } from './mock-adapter.mjs';
import { PythonInsurerAdapter } from './python-adapter.mjs';

// The single place that decides mock vs. real execution for a product/job. This
// keeps the "no silent fallback to mock" invariant in one auditable spot: a real
// product with no configured adapter is unavailable in strict/production mode,
// never quietly served by the mock.
//
// A product declares how it runs via `product.execution.mode`:
//   { mode: 'mock' }                      → MockInsurerAdapter  (isMock: true)
//   { mode: 'python', insurerId, ... }    → PythonInsurerAdapter (isMock: false)
export function createAdapterRegistry({ pythonAdapterUrl = null, strict = false, transport, fetchArtifact } = {}) {
  const mock = new MockInsurerAdapter();
  const python = new PythonInsurerAdapter({ endpoint: pythonAdapterUrl, ...(transport ? { transport } : {}), ...(fetchArtifact ? { fetchArtifact } : {}) });
  const configured = Boolean(pythonAdapterUrl);

  function describe(product) {
    const mode = product?.execution?.mode ?? 'mock';
    if (mode === 'mock') return { mode, adapter: mock, isMock: true, available: true, configured: true };
    if (mode === 'python') return { mode, adapter: python, isMock: false, available: configured, configured };
    return { mode, adapter: null, isMock: false, available: false, configured: false };
  }

  return {
    describe,

    // Called when creating a job: decides isMock and whether creation is allowed.
    resolveForProduct(product) {
      const info = describe(product);
      if (!info.adapter) throw new AppError(422, 'EXECUTION_INVALID', '产品执行方式无效。');
      // Never silently fall back to mock. A real product without a configured
      // adapter is unavailable in strict/production mode.
      if (info.mode === 'python' && !info.configured && strict) {
        throw new AppError(409, 'PRODUCT_UNAVAILABLE', '该产品暂未接入真实执行服务，暂不可用。');
      }
      return info;
    },

    // Called on tick: returns the adapter instance for a persisted job.
    resolve(job) {
      const mode = job?.execution?.mode ?? (job?.isMock ? 'mock' : 'python');
      if (mode === 'mock') return mock;
      if (mode === 'python') return python;
      return null;
    },

    status() {
      return { python: configured ? 'configured' : 'awaiting-hong-kong' };
    },
  };
}
