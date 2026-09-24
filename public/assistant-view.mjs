const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderAssistantReply(message, fields) {
  const allowed = message.compliance?.decision === 'allow' && !message.blocked;
  const blocked = message.blocked || message.compliance?.decision === 'block';
  const label = blocked ? '已转人工 · 合规拦截（block）' : allowed ? '合规通过（allow）' : '历史消息 · 审查状态未记录';
  // Fail closed on action cards, including old records without a decision.
  const content = blocked ? '这条回复已被拦截，已转人工核对。' : message.answer;
  const audit = message.compliance;
  const runtimeNote = message.metadata?.routedBy === 'dify'
    ? 'Dify 用于识别意图；固定意图由后端处理。回复发送前已完成后端出口审查。'
    : message.extraction
      ? '参数候选按字段来源标注；回复由后端生成并通过确定性出口审查。'
      : message.engine === 'dify'
      ? 'Dify 生成的文字已完成语义与后端确定性出口审查。'
      : message.engine === 'local-fallback'
        ? '本地有限规则处理，未调用 Dify；知识库待接入。'
        : '固定回复由后端处理；知识库待接入。';
  const extractionSource = message.extraction
    ? message.extraction.engine === 'dify' ? '参数来源按字段标注；Dify 已调用，参数待确认' : '本地规则提取，参数待确认'
    : '无可核实的产品来源';
  return `<div class="message assistant-message"><span class="message-label">业务助理 · 演示</span>
    <div class="compliance-state ${blocked ? 'compliance-block' : ''}" role="status">${escape(label)}</div>
    <p>${escape(content)}</p>
    ${audit ? `<details class="compliance-details"><summary>查看合规记录</summary><p>审查编号：${escape(audit.auditId)}</p><p>规则版本：${escape(audit.ruleVersion || '历史版本未记录')}</p><p>命中规则：${escape(audit.rules?.join('、') || '无')}</p></details>` : ''}
    ${allowed && message.extraction ? renderExtraction(message, fields) : ''}
    <small class="source-note">来源：${escape(blocked ? '合规出口拦截' : message.source || (message.extraction ? extractionSource : '无可核实的产品来源'))}</small>
    <small class="source-note">${escape(runtimeNote)}</small></div>`;
}

function renderExtraction(message, fields) {
  const result = message.extraction;
  const missing = fields.filter(f => result.params?.[f.key] === undefined).map(f => f.label);
  return `<div class="extraction-card"><div class="card-top"><strong>待确认参数卡</strong><span class="pill">参数待确认 · 未提交</span></div>
    <p>以下仅整理输入候选，尚未经纪确认，不能作为官方计划书数字。</p>
    <dl class="mini-facts">${fields.map(field => {
      const value = result.params?.[field.key];
      const display = value === undefined ? '待补充' : field.key === 'smoker' ? value ? '吸烟' : '不吸烟' : value;
      const source = result.sources?.[field.key] === 'dify-verified' ? 'Dify 识别、后端核实' : '本地规则提取';
      const unverified = result.unverified?.includes(field.key);
      return `<div><dt>${escape(field.label)}</dt><dd class="${value === undefined ? 'missing' : ''}">${escape(display)}</dd>${value !== undefined
        ? `<small>来源：${escape(source)}</small><small>输入依据：${escape(result.evidence?.[field.key] || '未记录，请手动核对')}</small>`
        : unverified ? '<small class="warning-text">模型识别到但无法核实，请手动填写</small>' : '<small>来源：本地规则未识别</small>'}</div>`;
    }).join('')}</dl>
    ${missing.length ? `<p class="warning-text">待补充：${escape(missing.join('、'))}</p>` : ''}
    ${result.conflicts?.length ? `<p class="warning-text">需核对冲突：${escape(result.conflicts.join('；'))}</p>` : ''}
    <button class="button primary full" data-action="use-extraction" data-id="${escape(message.id)}">补充并确认参数</button>
    <small>${escape(result.warning || '当前为有限规则提取演示，未调用大模型。')}</small></div>`;
}
