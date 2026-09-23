const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function renderProductControl(actor, product, control) {
  if (!control) return '';
  return `<section class="panel followup-panel"><h2>产品执行状态</h2><p role="status">${control.paused ? '已暂停新任务' : '可创建演示任务'}</p>
    <p>${escape(control.reason || '尚无暂停记录。')}</p>
    <p class="muted">暂停会阻止新提交，并将排队任务转入人工队列。已经执行中的任务继续核对结果；恢复产品后，人工队列不会自动重跑。</p>
    ${actor.role === 'operator' ? `<form id="product-control-form" data-product="${escape(product.id)}" data-revision="${escape(control.revision)}">
      <input type="hidden" name="paused" value="${!control.paused}">
      <label>处理原因<textarea name="reason" required minlength="2" maxlength="300" rows="3" placeholder="记录暂停原因或恢复前完成的检查"></textarea></label>
      <div class="form-error" role="alert"></div><button class="button ${control.paused ? 'primary' : 'secondary'}">${control.paused ? '恢复新任务' : '暂停新任务'}</button></form>` : ''}</section>`;
}
