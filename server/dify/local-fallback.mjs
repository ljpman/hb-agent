import { demoKnowledge } from '../catalog.mjs';
import { extractParameters } from './parameter-extractor.mjs';

// LocalFallbackDifyClient — the deliberately limited local engine used when no
// real Dify instance is configured. It is NOT an LLM and never claims to have
// called one. It only extracts parameter candidates and answers from the demo
// knowledge edge; it computes no benefit/return/cash-value numbers.
export class LocalFallbackDifyClient {
  isConfigured = false;

  status() { return { dify: 'not-configured' }; }

  // Text → product parameter candidates (mirrors the proposal_extract workflow).
  // Deterministic; never fabricates missing fields, never computes money.
  extractParams({ text, product }) {
    return extractParameters(text, product);
  }

  // Intent + reply draft (mirrors the broker_assistant_chat workflow). Returns a
  // draft only; the backend runs the compliance guard before anything is sent.
  chat({ text, product }) {
    if (/计划书|\d+\s*岁|年缴|年交/.test(text)) {
      return { kind: 'extraction', extraction: this.extractParams({ text, product }), answer: '已整理为待确认参数。请打开确认表单，补齐缺失项后提交。', engine: 'local-fallback' };
    }
    const entry = /失败|人工/.test(text) ? demoKnowledge[2] : /保证|收益|退保/.test(text) ? demoKnowledge[1] : /怎么|如何|生成|流程/.test(text) ? demoKnowledge[0] : null;
    return { kind: 'answer', answer: entry?.answer || '当前演示尚未接入正式知识库，无法核实这项产品问题。你可以先体验参数确认与计划书流程。', source: entry?.source || '演示资料边界', engine: 'local-fallback' };
  }
}
