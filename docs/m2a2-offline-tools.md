# M2a-2 离线工具契约与自验收

日期：2026-09-22。状态：M2a-2 离线实现完成；未连接 Dify、DeepSeek、香港端点或其他业务外网服务。
本地演示仍禁止 production 启动。GitHub 分支／PR 仅用于本次授权的代码交付。

## 鉴权与后端映射

业务后端内部调用 `service.difyGateway.issue(actor, { clientId?, jobId?, ttlMs? })`。
`actor` 必须来自可信会话／后端作业；没有对浏览器开放的令牌签发 API。签发仅接受经纪角色，
逐次检查客户及计划书的 tenantId、ownerId，jobId 必须属于绑定客户。不得将请求正文当作 actor。
工具令牌只允许访问签发时绑定的独立 `runId`、客户及可选计划书；运营角色没有工具网关越权特例。

返回的 `actor_token` 是随机 256 位短期能力令牌，最长五分钟；数据库只存令牌 hash、可信上下文和失效时间。
令牌同时作为 HMAC-SHA256 请求签名的短期材料，没有工作流长期业务密钥。
令牌到期不能刷新已有运行的权限；后续真实长流程的受控续签策略待 M2b 验证。
持有令牌意味着拥有其限定权限，签名不防令牌本身泄漏；未来服务桥接需受控后端传输、TLS、禁止日志记录，
不能把签名材料放入模型 prompt 或前端。当前没有真实工作流分发。

按租户、经纪、客户维护 SQLite `dify-conversation` 记录，随机 `user` 与 `conversation_id` 在重启后稳定。
这是本地映射编号，**不是已由真实 Dify 创建的会话**；真实 Dify 会话 ID 的绑定在 M2b 完成。
`/api/assistant` 使用此后端映射，忽略正文自报的 user/conversation_id；前端不接收这些内部标识或令牌。

所有工具请求需要以下请求头，普通演示 Cookie 不能代替它们：

| 请求头 | 约定 |
| --- | --- |
| Authorization | `Bearer <actor_token>` |
| X-Dify-Timestamp | UTC Unix 毫秒，13 位十进制，与后端时间相差不超过一分钟 |
| X-Dify-Nonce | 每次请求新建的 16–100 位字母／数字／下划线／连字符标识，建议 UUID |
| X-Dify-Signature | 小写十六进制 HMAC-SHA256，计算方式如下 |
| Content-Type | POST 使用 `application/json`，正文不超过 24 KB |

签名消息为 `method + '\n' + path + '\n' + timestamp + '\n' + nonce + '\n' + sha256(rawBody)`。
路径严格匹配下列路由，不接受附加查询参数；POST 按实际发送的 UTF-8 JSON 文本签名，不能验签后另换正文。
GET 正文为空。比较采用等时比较。有效签名的 nonce 即使后续字段校验失败也已消耗；重试用新 nonce。
nonce 在 SQLite 中以令牌 hash + nonce 唯一约束去重，持久化到令牌到期；签发时清理过期令牌与 nonce。
服务监听及 Host 限制仍只允许本机。浏览器业务接口继续保持原有会话与同源检查，工具接口改由签名鉴权。

## 接口

| 路由 | 必填正文／参数 | 结果 |
| --- | --- | --- |
| POST `/api/dify/tool/compliance-audit` | runId、originalText、draftReply | 201，保存后端重新计算的判定 |
| GET `/api/dify/tool/compliance-audit/{auditId}` | 路径中的 auditId，同样需签名 | 200，仅同一经纪、租户、runId 可查 |
| POST `/api/dify/tool/progress` | runId、caseId | 200，not-configured，progress/source/updatedAt 均 null |
| POST `/api/dify/callback` | runId、eventId、sequence、version、status | 200，accepted、可选 reason、当前 run |

`originalText` / `draftReply` 必须为非空字符串，最多 3000 字。未知字段拒绝。
合规保存返回 auditId、decision（allow/block）、rules、ruleVersion、originalHash（originalText）、
draftReplyHash（审查前候选）、replyHash（最终安全回复）。hash 均 SHA-256；工具审计不保存原文、候选正文或令牌。
被拦截时 replyHash 对应固定人工提示，不能把候选回复 hash 冒充最终回复 hash。
调用方不得自报 decision、规则版本或 citations；它们不能成为可信出处。

合规路径沿用 `evaluateCompliance` 的承诺话术／敏感字段／收益数字检查，并对无确定性核验来源的
工具／模型数字采用额外保守拦截，规则版本为 `m2a2-2`。没有经核验的官方数字来源，所以本里程碑
**不提供**模型收益、现金价值、保费或保障金额输出。语义审查、改写与完整知识事实核验属于后续阶段。

progress 的 `caseId` 当前仅表示已授权的内部演示客户记录，不代表真实保单或理赔案编号。
无来源时不填造进度，不把跟进卡阶段或 M1 计划书生成状态当作真实保单进度。

## 回调状态与文件边界

回调只更新后端签发时创建的 `dify-run`，不接受任意 jobId，也不调用 M1 adapter、transition 或 artifact 写入。
状态为 `queued → running → succeeded / failed / awaiting_manual`，也可从 queued 直接进入终态。
终态不能被任何新事件改回 running；awaiting_manual 同样作为终态，需另行人工处理。
这些是离线工作流接收记录，均标注 isMock 与 not-configured，不代表执行过真实 Dify。

eventId 为全局唯一内部事件标识；sequence/version 为正的安全整数。
同 eventId 同载荷返回 duplicate；复用 eventId 携带不同载荷／runId 返回 409。
sequence 不增加或 version 下降返回 stale；终态的新事件返回 terminal。忽略的合法事件同样记录，
不因重启后重发而重新生效。事件记录、状态与合规审计在一个 SQLite 事务内提交；写入失败全部回滚。

succeeded 必须附 originalText、draftReply；先执行出口审查，block 改为 awaiting_manual，
只存固定安全提示。其他状态不接受正文或文件字段。没有把回调原文转发到前端的旁路。

可选 `artifactRef` 只允许 `artifact:job-...`，必须正好等于令牌绑定的 jobId，所属经纪／租户正确，
且现有任务已 succeeded，数据库内文件有 `%PDF-` 头并且 hash 与任务记录一致。
仅返回内部引用，不接受本地路径、相对路径、file URL、任意远程 URL、新文件或跨任务文件。
这只复用既有 M1 已交付文件，不新增或替代真实 PDF 核验规则，也不把模拟文件标为官方文件。

常见错误：401 为缺鉴权／过期／时间戳／nonce／签名错误；403 为令牌资源范围错误；
404 为记录不存在或非所属记录；409 为重放、事件冲突或文件未就绪；422 为缺字段或非法字段。

## 前端与自验收

工作台助手已展示回复、allow/block、审查编号、规则版本和命中规则。
参数卡展示本地确定性抽取的候选值、输入依据、缺项、冲突及“未确认／未提交”标识；
false 保持“不吸烟”，金额使用原候选字符串，未知性别不推断。确认按钮只带入表单，不创建 draft/job。
block 隐藏候选回复及参数动作，显示“已转人工”。动态文本统一 HTML 转义。

执行 `node --test tests/*.test.mjs`：**35 通过，0 失败**，保留原有 20 项测试。

- 所有工具 POST 的缺令牌、令牌过期、错误签名、正文篡改、时间戳、nonce、重放、缺字段。
- 审计 GET 的鉴权、过期、验签、nonce、重放；跨经纪、跨租户、跨运行／客户范围校验。
- 事件去重、冲突、旧顺序／旧版本、所有终态保护、非法路径／URL、未核验／错配文件。
- 并发只接受一次；事务失败回滚后可重试；SQLite 重启后会话、nonce、事件、终态及审计保留。
- 异步助手回复先审查，伪造出处／模型参数卡不可直出；凭据型输入进入客户端或存储前被拒绝。
- 前端 allow/block、参数证据、缺项／冲突、false、金额候选、确认动作与 HTML 转义。
- 应用拒绝真实 Dify 环境配置；HTTP 测试只连接随机本机端口，Dify/Python 契约测试只注入离线 transport。

本地浏览器已走查：发送示例需求 → 查看 allow 与合规记录 → 参数卡显示缺失性别、非吸烟及输入依据 →
点击“补充并确认参数” → 表单正确带入候选，性别继续留空，未自动创建计划书任务。
block 显示及隐藏动作由后端注入与前端渲染测试验证。

## 待输入／待环境

M1b 真实产品字段、官方 PDF 样本与香港端点仍待输入；M2b 真实 Dify、DeepSeek、三工作流部署、
真实会话绑定、受控服务桥接和长期运行续签仍待环境；真实保单／理赔数据源与服务关系授权仍待输入。
M3 知识库未开始。企业登录、密钥存储、TLS、限流、审计保留期及运维验收仍是生产前工作。
本次仅交付 M2a-2，创建 PR 后等待人工合并，不自行合并或进入下一里程碑。

## 合并前补充审查

补充回归发现中文金额／收益（港币、美金、成数，以及省略单位的中文保额）可能绕过旧版数字检查。
规则版本更新为 `m2a2-2`，保险财务语境中的中文数字采用保守拦截；新增用例同时覆盖合规工具、
异步回调和助手出口。此规则可能将含中文数词的普通财务说明转人工，不因此放宽金额来源要求。
测试总数现为 35，原有测试全部保留。真实知识事实与语义审查仍待后续里程碑。
