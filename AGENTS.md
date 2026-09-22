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

**仍是 mock / 未接入**
- 计划书执行：仅 `MockInsurerAdapter`（本地生成显著标注的模拟 PDF）。`PythonInsurerAdapter`
  是骨架，**未连接任何真实香港端点，未声称支持任何真实保司**。
- 参数抽取 `extract()`：本地有限规则演示，**非** LLM / Dify。
- 知识问答 `assistant()`：演示知识边界，未接正式知识库。
- Dify、香港 Python、真实保司门户、APP IM：全部未接入。`/api/bootstrap` 诚实返回
  `python: awaiting-hong-kong / configured`、`dify: not-configured`、`im: prototype-only`。

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
- **M2 · 接 Dify**（意图识别、知识问答、参数抽取、合规审查）— 未开始。
- **M3 · 知识库**（产品条款、操作流程、合规红线、门户手册；带来源、版本、失效日期）— 未开始。

映射关系（供对照，不改变上面的执行顺序）：M1 对应 [交付计划](docs/delivery-plan-v1.md) 的
封装服务与真实保司链路（步骤 2–3）；M2/M3 对应 [Dify 计划](docs/dify-workflow-plan.md) 的三个
工作流与知识库组织。各文档的"阶段/步骤编号"是规划记录，执行顺序以本 §3 为准。

---

## §4 工作纪律

- 一次一个 milestone；每个改动**写测试**，且**不破坏现有测试**：`node --test tests/*.test.mjs`。
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
  - `python-adapter.mjs`（`PythonInsurerAdapter` 骨架，说对接契约）
  - `registry.mjs`（**唯一的 mock/real 判定点**，无静默回退）
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
[开发任务清单](docs/development-backlog.md)、[README](README.md)。
