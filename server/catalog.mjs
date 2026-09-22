export const product = {
  id: 'demo-savings-01', name: '演示储蓄计划', insurer: '示例保司',
  version: 'DEMO-2026.1', schemaVersion: '1', isMock: true,
  description: '用于走查经纪工作流程。字段与范围为演示规则，尚未接入任何真实产品。',
  fields: [
    { key: 'age', label: '被保险人年龄', type: 'integer', min: 18, max: 70, required: true },
    { key: 'gender', label: '被保险人性别', type: 'enum', options: ['男', '女'], required: true },
    { key: 'smoker', label: '吸烟状态', type: 'boolean', required: true },
    { key: 'currency', label: '币种', type: 'enum', options: ['USD', 'HKD'], required: true },
    { key: 'annualPremium', label: '年缴保费', type: 'decimal', min: '1000.00', max: '1000000.00', required: true },
    { key: 'paymentTerm', label: '缴费年期', type: 'enum', options: ['5', '10'], required: true }
  ]
};
export const demoActors = {
  broker: { id: 'broker-lin', tenantId: 'demo-agency', name: '林经理', role: 'broker' },
  colleague: { id: 'broker-zhou', tenantId: 'demo-agency', name: '周经理', role: 'broker' },
  other: { id: 'broker-other', tenantId: 'other-agency', name: '其他机构', role: 'broker' },
  operator: { id: 'operator-demo', tenantId: 'demo-agency', name: '运营专员', role: 'operator' }
};
export const statusLabels = {
  queued: '排队中', running: '正在生成', validating: '核对文件', succeeded: '已完成',
  awaiting_manual: '待人工处理', failed: '生成失败'
};
export const scenarios = ['success', 'manual', 'failed', 'mismatch'];
export const followupStages = ['需求沟通', '方案准备', '方案讲解', '待客户反馈', '暂缓跟进'];
export const demoKnowledge = [
  { question: '怎样生成一份计划书？', answer: '先选择客户，填写参数并在确认页核对。提交后可在任务详情查看进度，完成后打开模拟文件。', source: '演示流程说明 · 第 1 条' },
  { question: '保证与非保证利益有什么区别？', answer: '这份演示没有真实产品条款或利益数据，不能据此解释某款产品的保证范围。接入正式资料后，应分别引用相应条款及利益演示。', source: '演示资料边界 · 第 2 条' },
  { question: '失败了怎么处理？', answer: '任务会显示原因。需要重新登录、人工核对或文件错配时，运营人员可以在待处理队列中接手；不会把错误结果显示为已完成。', source: '演示流程说明 · 第 3 条' }
];
