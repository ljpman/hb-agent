import { STATUS, ERROR } from './insurer-adapter.mjs';

// Mock insurer adapter. It drives the demonstration state machine using the
// job's scenario and renders a conspicuously simulated PDF via ctx.pdf. It
// never represents an official insurer document, and it computes no insurance
// benefit numbers — the PDF only echoes broker-confirmed inputs.
//
// Behaviour is intentionally identical to the previous inline mock in the
// Service: queued → running → validating → succeeded, with the manual / failed /
// mismatch scenarios branching off. The three-step cadence is preserved.
export class MockInsurerAdapter {
  isMock = true;

  async advance(job, ctx) {
    if (job.status === STATUS.queued) {
      return { kind: 'transition', status: STATUS.running, text: '模拟服务正在准备演示文件' };
    }
    if (job.status === STATUS.running) {
      if (job.scenario === 'manual') {
        return { kind: 'transition', status: STATUS.awaiting_manual, text: '模拟登录过期，已进入人工队列', error: ERROR.AUTH_REQUIRED };
      }
      if (job.scenario === 'failed') {
        return { kind: 'transition', status: STATUS.failed, text: '模拟门户暂不可用，请新建任务重试', error: 'PORTAL_UNAVAILABLE' };
      }
      return { kind: 'transition', status: STATUS.validating, text: '正在核对模拟文件与确认参数' };
    }
    // validating
    if (job.scenario === 'mismatch') {
      return { kind: 'transition', status: STATUS.awaiting_manual, text: '模拟文件参数不一致，已阻止交付', error: ERROR.PDF_MISMATCH };
    }
    try {
      const bytes = await ctx.pdf(job);
      if (!(Buffer.isBuffer(bytes) && bytes.subarray(0, 5).toString() === '%PDF-')) throw new Error('PDF_GENERATION_FAILED');
      return { kind: 'artifact', bytes, text: '模拟 PDF 已生成，输入参数与任务快照一致' };
    } catch {
      return { kind: 'transition', status: STATUS.failed, text: '模拟 PDF 生成失败，请检查本地 Python 与 reportlab 环境', error: 'PDF_GENERATION_FAILED' };
    }
  }
}
