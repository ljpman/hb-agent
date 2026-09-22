const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderAssistantReply(message, fields) {
  const allowed = message.compliance?.decision === 'allow' && !message.blocked;
  const blocked = message.blocked || message.compliance?.decision === 'block';
  const label = blocked ? '已转人工 · 合规拦截（block）' : allowed ? '合规通过（allow）' : '历史消息 · 审查状态未记录';
  // Fail closed on action cards, including old records without a decision.
  const content = blocked ? '这条回复已被拦截，已转人工核对。' : message.answer;
  const audit = message.compliance;
  return `<div class="message assistant-message"><span class="message-label">业务助理 · 演示</span>
    <div class="compliance-state ${blocked ? 'compliance-block' : ''}" role="status">${escape(label)}</div>
    <p>${escape(content)}</p>
    ${audit ? `<details class="compliance-details"><summary>查看合规记录</summary><p>审查编号：${escape(audit.auditId)}</p><p>规则版本：${escape(audit.ruleVersion || '历史版本未记录')}</p><p>命中规则：${escape(audit.rules?.join('、') || '无')}</p></details>` : ''}
    ${allowed && message.extraction ? renderExtraction(message, fields) : ''}
    <small class="source-note">来源：${escape(blocked ? '合规出口拦截' : message.source || (message.extraction ? '用户输入 · 本地有限规则提取，参数待确认' : '无可核实的产品来源'))}</small>
    <small class="source-note">本地演示，未调用 Dify；正式知识库待接入。</small></div>`;
}

function renderExtraction(message, fields) {
  const result = message.extraction;
  const missing = fields.filter(f => result.params?.[f.key] === undefined).map(f => f.label);
  return `<div class="extraction-card"><div class="card-top"><strong>待确认参数卡</strong><span class="pill">未提交</span></div>
    <p>以下仅整理输入候选，尚未经纪确认，不能作为官方计划书数字。</p>
    <dl class="mini-facts">${fields.map(field => {
      const value = result.params?.[field.key];
      const display = value === undefined ? '待补充' : field.key === 'smoker' ? value ? '吸烟' : '不吸烟' : value;
      return `<div><dt>${escape(field.label)}</dt><dd class="${value === undefined ? 'missing' : ''}">${escape(display)}</dd>${value !== undefined ? `<small>输入依据：${escape(result.evidence?.[field.key] || '未记录，请手动核对')}</small>` : ''}</div>`;
    }).join('')}</dl>
    ${missing.length ? `<p class="warning-text">待补充：${escape(missing.join('、'))}</p>` : ''}
    ${result.conflicts?.length ? `<p class="warning-text">需核对冲突：${escape(result.conflicts.join('；'))}</p>` : ''}
    <button class="button primary full" data-action="use-extraction" data-id="${escape(message.id)}">补充并确认参数</button>
    <small>${escape(result.warning || '当前为有限规则提取演示，未调用大模型。')}</small></div>`;
}
