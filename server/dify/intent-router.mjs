const normalized = text => String(text ?? '').normalize('NFKC');

export const KNOWN_INTENTS = Object.freeze(['proposal', 'progress', 'followup', 'knowledge']);

export function isPolicyClaimsProgress(text) {
  const query = normalized(text);
  return /(?:保单|保單|理赔|理賠|赔案|賠案)/.test(query) &&
    /(?:进度|進度|状态|狀態|进展|進展|查询|查詢|查|到哪|如何|情况|情況)/.test(query);
}

function isAmbiguousCaseProgress(text) {
  const query = normalized(text);
  const caseWord = '(?:案件|個案|个案)';
  const stageWord = '(?:进度|進度|进展|進展|状态|狀態|环节|環節|阶段|階段|走到哪|到哪|哪一步)';
  return new RegExp(`${caseWord}.{0,16}${stageWord}|${stageWord}.{0,16}${caseWord}`).test(query);
}

export function classifyIntent(text) {
  const query = normalized(text);
  if (isPolicyClaimsProgress(query) || isAmbiguousCaseProgress(query) || /计划书任务.{0,8}(?:进度|進度|状态|狀態)|任务状态|任務狀態|(?:查询|查詢|查下|查一下|查看|看下).{0,8}(?:计划书|計劃書).{0,8}(?:进度|進度|状态|狀態)|(?:进度|進度|状态|狀態).{0,8}(?:计划书|計劃書)/.test(query) ||
      /进度|進度/.test(query) && !/(?:下周|下週|明天|明日).{0,6}跟进|跟進|提醒/.test(query)) return 'progress';
  if (/提醒|跟进|跟進|回访|回訪|联系|聯絡|联络|跟进卡|跟進卡/.test(query)) return 'followup';
  if (/计划书|計劃書|建议书|建議書|出计划|出計劃|生成计划|生成計劃|准备.{0,4}(?:一份)?计划|準備.{0,4}(?:一份)?計劃|提交(?:计划书|計劃書|方案)?|直接(?:帮我)?提交|提交并忽略|提交並忽略|马上生成|馬上生成/.test(query)) return 'proposal';
  // A complete-looking age + annual-premium request is itself a clear proposal
  // intent, even when the user omits the words "计划书" or "出方案".
  if (/(?:年龄|年齡)\s*(?:是|为|為|[:：])?\s*\d{1,3}|\d{1,3}\s*[岁歲]/.test(query) && /年缴|年繳|年交|每年/.test(query)) return 'proposal';
  if (/条款|條款|投保|保费|保費|现金价值|現金價值|退保价值|退保價值|保障|收益|回报|回報|产品|產品|利益|分红|分紅|保额|保額/.test(query)) return 'knowledge';
  return null;
}

export function isKnownIntent(value) {
  return KNOWN_INTENTS.includes(value);
}
