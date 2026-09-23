import { demoKnowledge } from '../catalog.mjs';
import { AppError } from '../errors.mjs';
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
      // RL-01a: no estimate of any benefit; point to the official proposal instead.
      return { kind: 'extraction', extraction: this.extractParams({ text, product }), answer: '已整理为待确认参数。请打开确认表单，补齐缺失项后提交。利益数字以保司官方计划书为准，助手不作估算。', engine: 'local-fallback' };
    }
    const entry = /失败|人工/.test(text) ? demoKnowledge[2] : /保证|收益|退保/.test(text) ? demoKnowledge[1] : /怎么|如何|生成|流程/.test(text) ? demoKnowledge[0] : null;
    // RL-02a: with no knowledge base, product-fact questions must say "无法核实".
    const answer = !entry ? '当前演示尚未接入正式知识库，无法核实这项产品问题。你可以先体验参数确认与计划书流程。'
      : entry === demoKnowledge[1] ? `无法核实。${entry.answer}` : entry.answer;
    return { kind: 'answer', answer, source: entry?.source || '演示资料边界', engine: 'local-fallback' };
  }

  // There is no semantic compliance review without the compliance_guard app. Say
  // so; the deterministic exit guard (saveCompliance) still runs in the backend.
  reviewCompliance() {
    throw new AppError(503, 'DIFY_APP_NOT_CONFIGURED', 'Dify 应用 compliance_guard 未配置，未进行语义审查；仅执行确定性出口规则。');
  }
}
