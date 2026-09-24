# AGENTS.md · AI 入口说明

本文件是**给 AI 智能体的入口说明**。开始任何工作前，先读完本文，再按 §6 读权威业务文档。
本文只做汇总与纪律约定；具体业务方案以 §6 的权威文档为准，不在此处新增未经确认的结论。

这是一个**保险经纪 AI 智能体**：为已登录、已授权的渠道经纪，从需求描述到后续跟进，提供
官方计划书生成、带出处的讲解包和轻量客户跟进卡。当前是**本地交互原型**——真实保司门户、
香港 Python、Dify 和 APP IM 仍待接入，页面与文件始终标注"演示／模拟"。

---

## §1 项目现状（哪些已完成，哪些仍是 mock）

**已完成（真实逻辑，不是演示）**
- 认证与隔离：HttpOnly/SameSite=Strict 演示会话、同源校验、`tenantId`+`ownerId` 逐记录鉴权。
- 确定性参数校验：`false`（非吸烟）不当缺失、金额 BigInt 定点正规化。
- 确认快照 + 幂等：不可变 draft、`revision`+`paramsHash`+30 分钟失效、`Idempotency-Key`。
- 持久任务状态机：`queued→running→validating→succeeded` + `awaiting_manual`/`failed`，SQLite
  持久化，重启恢复。
- 鉴权下载、讲解包（经纪复核后导出）、客户跟进卡（乐观锁）、运营人工队列。
- **执行器 adapter 抽象层（M1a 已落地）**：`InsurerAdapter` 接口 + `MockInsurerAdapter` +
  `PythonInsurerAdapter` 骨架 + registry；`isMock` 由实际运行的 adapter 诚实导出。
- **Dify 集成地基（M2a-1 已落地）**：`DifyClient` 抽象 + 诚实降级 + 确定性**出口合规守卫**
  `evaluateCompliance`（发送前拦截无来源数字/承诺话术/敏感字段），`assistant` 出口经此守卫并记审计。
- **M2a-2 离线工具与网关已完成**：后端短期 `actor_token`、请求签名／时间戳／持久 nonce、
  经纪与资源范围校验、后端会话映射；合规判定与 hash 持久保存／鉴权查询；异步回调事件去重、
  顺序／版本与终态保护；工作台展示合规结果、输入依据及待确认参数卡。详见
  [M2a-2 契约与自验收](docs/m2a2-offline-tools.md)。
- **M1 本地加固（2026-09-22/23）**：`PythonInsurerAdapter` 请求截止、禁止重定向、任务／尝试／产品绑定、
  响应字段白名单；adapter 不能覆盖身份／快照，非法状态跳转被拒，状态／文件与审计原子落库。
- **多进程任务租约**：SQLite 租约 + 心跳续租，结果提交校验 token／快照；真实调用前落库尝试编号，
  租约失效或结果未落库转人工，不自动重提。
- **执行账号隔离**：`execution_resources` 按服务端 `credentialRef` 串行（跨租户同样）；结果不确定时保持占用，
  运营核实门户结束后才释放。
- **产品暂停／恢复**：运营按租户暂停（必填原因）、`PORTAL_CHANGED` 自动暂停，排队任务转人工，恢复不自动重跑。
  见 [产品暂停与人工处理](docs/product-operations.md)。
- **完整产品确认快照**：draft／job 保存 `productSnapshot`+hash，产品版本、字段约束、保司或执行方式漂移需重新确认。
- **离线参数抽取加固**：`server/dify/parameter-extractor.mjs`，冲突留空、不推断性别；`/api/extract` 校验
  `schemaVersion`（旧版 409）；下载复核文件 hash（`FILE_INTEGRITY`）。
- **M1b 交付核验闸门（离线预备）**：`validating` 时 adapter 只能经注入的 `fetchArtifact` 取回候选文件，
  由业务服务 `server/verify/pdf-verifier.mjs` 按确认快照逐字段＋版本核验，通过才 `succeeded` 并释放账号；
  不一致 `PDF_MISMATCH`、无法核验 `RESULT_UNKNOWN`，均转人工且保留占用。证据不存 PDF 读出的值。
  样本包接收检查：`scripts/check-samples.mjs`。
- **Dify 离线加固（2026-09-23）**：出口／输入合规守卫识别香港身份证号（校验位确定性核对，规则版本 `m2a2-3`）；
  `DifyClient` 按应用分别配置 key（chat／extract／compliance），不共用、不顶替，缺哪个只那项报未配置；
  参数抽取不把"收益／回报"旁的金额当保费；RL 红线用例写成离线回归（`tests/dify-redline.test.mjs`）。
- **M2b 开发联调版（2026-09-24）**：本机 Windows Dify 1.17.1 的三个 `hb-agent-dev-*` 工作流保持已发布（assistant v1、extract v2、compliance v3）；上一轮真实验收 **116/116**、UI 预览 **10/10**。本轮完整真实重验历史 **136/137**（105 次请求：chat 22、extract 51、review 32）；I08 含糊案件问法经后端确定性路由后本机单例验收 **1/1**，该次 Dify 请求为 0；此前模型对该句曾返回 `unknown` 和 `progress`，因此不依赖模型分类。完整离线测试 **235/235**。抽取候选核实此前补充字段为 0，现默认停用；需同时显式 `HB_DIFY_MODE=dev` 与 `HB_DIFY_EXTRACT_MODE=dev` 才启用，应用和确定性核实实现保留，待真实多字段产品接入后再评估。后端先判明确意图、proposal 只返回待确认参数卡、计划书进度按经纪／租户隔离、followup 只读。开发版采用后端编排，不让 Dify 调用后端工具，gateway 校验保持不变；正式 M2b 仍未完成。详见 [M2b 开发联调版记录](docs/m2b-dev.md)。
- 验收基线：本轮开始时 222 项全部通过；当前 Node 24 完整离线测试 **234 项通过、0 项失败**。本地 PDF smoke 曾失败于 `PDF_GENERATION_FAILED`；当时缺少可用 Python（`python`／`python3` 是 WindowsApps 执行别名，未找到 `py.exe`），未安装软件。
  详见 [接续与验收记录](docs/progress-2026-09-22.md)。

**仍是 mock / 未接入**
- 计划书执行：仅 `MockInsurerAdapter`（本地生成显著标注的模拟 PDF）。`PythonInsurerAdapter`
  是骨架，**未连接任何真实香港端点，未声称支持任何真实保司**。
- 真实文件交付（M1b 待补）：**没有任何真实产品的核验规则**（须按签认样本 `checklist.md` 编写），所以真实候选文件
  仍一律转人工；香港侧文件取回 `fetchArtifact` 无默认实现；真实任务讲解包未接入（`PACKAGE_NOT_READY`）。
- 参数抽取 `extract()` 默认只用后端确定性规则，标注 `engine=local-rule-demo`、`isMock=true`，不发送 extract 请求；候选核实代码和开发应用保留，只有开发模式显式设 `HB_DIFY_EXTRACT_MODE=dev` 才启用。原因是 E11 与此前候选核验累计补充 **0 个字段**，待真实多字段产品再评估。assistant 开发模式仍按独立 key 调用 chat/compliance；后端先判明确意图，proposal 返回未提交的待确认参数卡；Dify 无知识库时固定回答“无法核实”。计划书进度读取本人任务，保单／理赔进度未接入；followup 只读当前客户卡。开发版不由 Dify 调用后端工具，M3 知识库未接入。联调记录见 [docs/m2b-dev.md](docs/m2b-dev.md)。
- 香港 Python、真实保司门户、真实 Dify 实例、知识库、APP IM：未接入。`/api/bootstrap` 诚实返回
  `python: awaiting-hong-kong / configured`、`dify: not-configured / partially-configured / configured`、`im: prototype-only`。
- M2a-2 应用入口拒绝任一预留 Dify 环境变量（`DIFY_ENV_VARS`），正常运行只返回 `dify: not-configured`；
  `HttpDifyClient` 仅保留注入离线 transport 的契约测试。进度工具只返回 `not-configured`、
  空来源／空进度；真实保单／理赔查询**未完成**。回调仅更新独立 `dify-run`，不驱动 M1 执行器。

---

## §2 红线（硬约束，任何改动都不得违反）

1. **模型绝不生成任何保险金额／收益数字。** 系统对外的数字只有两类来源：(a) 经纪已确认的
   输入参数原样复述；(b) 官方 PDF 经**确定性代码**解析并与确认快照逐项核对的字段。LLM／解析器
   **不计算、不推测、不生成**任何收益、回报率、现金价值、保费或保障金额。无法可靠核对时**转人工**，
   不允许"看起来对就交付"。
2. **real ≠ mock 严格分离。** 生产禁止静默回退 mock；`isMock` 必须等于实际运行的 adapter；
   真实产品无配置 adapter → 返回不可用，不伪造 URL、不把模拟文件伪装成官方文件。
3. **凭据只用 `credentialRef`**，绝不进 prompt / 日志 / 审计正文 / 聊天 / 代码库。
4. **认证、租户隔离、幂等、确认快照、任务恢复**语义不得破坏：身份取自会话而非请求体；
   知道 jobId/caseId ≠ 有权访问；真实 `running` 任务重启后不盲目重做，结果不确定转人工。
5. **PDF 交付前核验**：确为 PDF、来源与产品版本一致、关键参数与确认快照一致、未跳回登录页、
   未与其他任务串文件；无法可靠核验时转人工。
6. **出口审查在发送前完成**（先流出再扫描无法撤回）。
7. **诚实**：不假装已部署、已接通或已支持真实保司；未接入的能力如实标注。

---

## §3 里程碑顺序（当前执行口径，从 M1 开始）

一次只做一个 milestone，做完再进下一个。

- **M1 · 接香港 Python**
  - **M1a**（adapter 抽象、诚实 `isMock`、离线测试）— ✅ **已完成**。
  - **M1b**（接真实香港端点、1 社 1 产品实字段、样本核验、真实 PDF 核对）— ⏳ **待输入，未完成**。
    需要：1 社/1 产品/官方版本、入口函数与运行命令/依赖、真实字段与约束、PDF 获取方式、
    登录/MFA 方式、3–5 组"官方输入↔官方PDF"样本、`credentialRef`（不要明文密码）。
    对外资料请求单、样本规范与验收用例已备：[docs/handoff/m1b/](docs/handoff/m1b/request-hk.md)。
- **M2 · 接 Dify**（意图识别、知识问答、参数抽取、合规审查）
  - **M2a-1**（DifyClient 抽象、诚实降级、确定性出口合规守卫、`assistant` 出口审查）— ✅ **已完成**。
  - **M2a-2**（Dify 工具接口：`compliance-audit` 保存、`callback` 签名校验+去重、`progress` 骨架；
    鉴权网关：短期令牌、后端校验身份/数据范围、`user`/`conversation_id` 后端维护映射）— ✅ **离线部分已完成**。
    工作台已接合规判定／参数卡／出处；M2a-2 验收时 35 项离线测试通过。真实进度与真实 Dify 部署仍未完成。
  - **M2b 正式验收**（审批过的香港 Dify 实例 + DeepSeek + 三工作流 DSL 部署 + API key）— ⏳ **未完成**。
    **M2b 开发联调版**（同一 Windows 电脑上的本机 Dify，虚构数据）— 🟡 **上一轮后端 → Dify 验收 116/116；本轮完整真实重验历史 136/137（105 次请求）；I08 确定性后端复测 1/1（Dify 请求 0）；离线测试 235/235**：三个 `hb-agent-dev-*` 应用保持已发布；I08 直接由后端给出本人计划书任务状态和保单／理赔未接入提示，不依赖曾出现波动的模型意图分类。E11 与既有候选核验没有补充字段（0）；extract Dify 默认关闭，显式开发开关、应用和核实代码保留，待真实多字段产品再评估。开发版由后端编排审计和进度，不在 Dify workflow 传递短期令牌或加入工具节点；gateway 未放宽。正式 M2b 仍未完成。当前记录：[docs/m2b-dev.md](docs/m2b-dev.md)。
    环境请求单、隐私审批问题、验收规划见 [docs/handoff/m2b-m3/](docs/handoff/m2b-m3/request-dify.md)。
- **M3 · 知识库**（产品条款、操作流程、合规红线、门户手册；带来源、版本、失效日期）— 未开始。
  知识问答分支依赖知识库，在 M3 验收；资料接收规范见 [kb-intake](docs/handoff/m2b-m3/kb-intake.md)。
- **上线验收**（APP 登录／IM、生产部署、监控备份、运营参数、经纪试点）— 未开始；
  对接问题单与试点方案见 [docs/handoff/launch/](docs/handoff/launch/pilot-plan.md)。

映射关系（供对照，不改变上面的执行顺序）：M1 对应 [交付计划](docs/delivery-plan-v1.md) 的
封装服务与真实保司链路（步骤 2–3）；M2/M3 对应 [Dify 计划](docs/dify-workflow-plan.md) 的三个
工作流与知识库组织。各文档的"阶段/步骤编号"是规划记录，执行顺序以本 §3 为准。

---

## §4 工作纪律

- 一次一个 milestone；每个改动**写测试**，且**不破坏现有测试**：`npm test`（需 Node 24+；本机较低时用
  `npm exec --yes --package=node@24 -- node --test tests/*.test.mjs`），涉及执行链路再跑 `npm run test:smoke`。
- 真实与模拟边界清楚区分；`isMock` 保持诚实。缺输入时如实返回"未配置/待验证"，不伪称已调用。
- 不把纯内存队列当可交付任务库；任务事实持久化（现为 SQLite）。
- 动手前先与用户确认理解与计划（尤其涉及 §2 红线时）；不自作主张 commit / 开 PR / 对外发送。
- 凭据、真实客户资料不进聊天与代码库。

---

## §5 代码地图（快速定位）

- `server/index.mjs` — HTTP 层：会话、路由、静态、生产守卫、registry 配线。
- `server/service.mjs` — 业务服务：校验、draft/job、状态机 `tick()`/`recover()`、讲解包、跟进、
  人工队列、`extract()`、`assistant()`。
- `server/adapters/` — 执行器抽象：
  - `insurer-adapter.mjs`（接口契约 + 状态/错误码常量）
  - `mock-adapter.mjs`（`MockInsurerAdapter`，演示 PDF）
  - `python-adapter.mjs`（`PythonInsurerAdapter` 骨架：截止时间、禁止重定向、任务／尝试绑定、响应白名单）
  - `registry.mjs`（**唯一的 mock/real 判定点**，无静默回退）
- `server/verify/pdf-verifier.mjs` — 真实候选文件的确定性核验（结构检查＋按产品版本注册的定位规则，业务服务调用）。
- `server/dify/` — Dify 集成：
  - `dify-client.mjs`（`DifyClient` 接口、`HttpDifyClient` 骨架、`createDifyClient` 工厂，key 只在后端）
  - `local-fallback.mjs`（`LocalFallbackDifyClient`，未配置时的本地降级引擎）
  - `parameter-extractor.mjs`（离线有限规则参数抽取：冲突留空、输入原文作依据）
  - `compliance.mjs`（`evaluateCompliance`，**发送前的确定性出口红线守卫**）
  - `gateway.mjs`（后端令牌签发、持久会话／nonce、合规审计、进度骨架、独立回调状态机）
- `public/assistant-view.mjs` — 合规状态、审查详情、输入依据与待确认参数卡；block 隐藏动作。
- `public/product-control.mjs` — 运营「产品与资料」暂停／恢复表单。
- `tests/dify-tools.test.mjs` / `tests/assistant-view.test.mjs` — 离线 HTTP 安全矩阵、重启／并发／回滚、前端渲染。
- `tests/worker-lease.test.mjs`（含 `tests/helpers/lease-worker.mjs` 子进程）/ `execution-resource` /
  `product-control` / `extraction` — 租约、账号占用、产品暂停、参数抽取语料。 `scripts/smoke.mjs` — 实际 Python 全流程冒烟。
- `tests/pdf-verifier.test.mjs` / `real-delivery` / `sample-check` — 核验器、真实交付闸门、样本包接收检查
  （全部为测试夹具）。 `scripts/check-samples.mjs` — M1b 样本包接收检查。
- `server/catalog.mjs` — 演示产品/角色/知识/状态标签。
- `server/store.mjs` — SQLite 持久化。 `server/pdf.mjs` + `scripts/demo_pdf.py` — 模拟 PDF。
- `server/errors.mjs` — `AppError` / `check`。 `public/` — 前端。 `tests/` — service/http/adapter 测试。

任务状态机：`queued→running→validating→succeeded`，分支 `awaiting_manual`/`failed`；
每步由 `Service.tick()` 委托 `adapter.advance(job, ctx)`，结果经 `applyOutcome` 落地。

---

## §6 权威业务文档（读完本文后必读）

- [docs/insurance-agent-v2.md](docs/insurance-agent-v2.md) — 架构与工程评审 v2：接口、安全边界、P1 任务书、
  adapter 与官方 PDF 核验、mock 与真实分离。
- [docs/python-integration-contract.md](docs/python-integration-contract.md) — 香港现有 Python 对接契约：
  请求/结果/状态/错误码边界（M1b 依据）。
- [docs/dify-workflow-plan.md](docs/dify-workflow-plan.md) — Dify 三个工作流、接口、安全边界、验收样例（M2/M3 依据）。

补充参考：[分阶段交付计划](docs/delivery-plan-v1.md)、[第一步启动包](docs/phase-01-start-pack.md)、
[开发任务清单](docs/development-backlog.md)、[接续与验收记录](docs/progress-2026-09-22.md)、
[产品暂停与人工处理](docs/product-operations.md)、[README](README.md)。

对外对接包（`docs/handoff/`，发给香港、平台、法务、APP 等外部方的请求单与验收规划，未知项一律"待确认"）：
[M1b](docs/handoff/m1b/request-hk.md)、[M2b+M3](docs/handoff/m2b-m3/request-dify.md)、[上线](docs/handoff/launch/request-app.md)。
