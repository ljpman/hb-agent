# 香港现有 Python · 对接契约草案

日期：2026-09-21。状态：拟议接口，不是当前 Python 文件已支持的 API。用户已有几家保司可用脚本，位于香港电脑，当前不便提供；因此先约定产品化边界，待代码可访问时适配。

## 1. 接入原则

既有 Python 保留；由一个薄服务层或 Worker 把各脚本接入统一任务系统。代码和运行环境可以留在香港，不以搬到当前电脑为前提。

如果已有 API、队列、持久化或鉴权，优先核实并复用，不能重复搭一套相互冲突的任务管理。原文件没有服务入口时，可封装为 Python 内部调用或独立进程；具体方式取决于同步／异步模型及浏览器库。

面向经纪的业务接口只与业务后端交互。Python 执行服务不直接暴露保司凭据、Cookie、任意 shell 命令或任意网址访问能力。产品、脚本入口和输出目录来自服务端允许的目录配置。

## 2. 职责分界

| 层 | 负责什么 |
| --- | --- |
| APP／H5 | 收集参数、展示确认页、展示任务与文件 |
| 业务后端 | 用户身份与授权、schema 校验、不可变确认、幂等、任务事实、结果权限、通知 |
| Python 服务／Worker | 使用获准任务和凭据引用调用既有脚本，返回阶段、结果及结构化错误 |
| 原保司脚本 | 复用已有登录、页面操作、生成与下载逻辑；只修复已识别缺口 |
| 文件核验与存储 | 验证结果与任务一致，保存受控文件引用及证据；不可验证时转人工 |

可以由同一 Python 项目实现多层，但职责、授权边界和可恢复状态必须明确。

## 3. 建议内部请求

以下全部是演示值，不代表已经接通的公司、产品或真实客户。真实字段以现有脚本及官方表单为准。

```json
{
  "contractVersion": "1",
  "jobId": "demo-job-001",
  "attemptId": "demo-attempt-001",
  "productId": "demo-product",
  "productVersion": "demo-version",
  "schemaVersion": "1",
  "confirmationRef": "demo-confirmation-001",
  "paramsHash": "server-computed-hash",
  "params": {
    "age": 35,
    "smoker": false,
    "currency": "USD",
    "annualPremium": "10000.00",
    "paymentTerm": "5"
  },
  "credentialRef": "server-managed-credential-reference",
  "deadlineAt": "server-assigned-UTC-deadline"
}
```

这些字段由业务后端在确认与授权之后构造，不直接转发客户端提交的凭据引用、任务所有者或文件位置。Python 服务还要验证调用方身份和任务范围；不能仅因字段格式正确就执行。

`paramsHash` 绑定服务器保存的规范化快照，规范化规则要版本化。`jobId` 在重试中不变，`attemptId` 每次尝试改变。脚本实际执行前取得任务租约，避免重复消费者并发执行同一任务。

## 4. 接受与执行结果

HTTP 方式可使用 `POST /internal/proposal-jobs` 接受任务并返回 202；队列方式使用同等消息契约。二者是可选实现方式，不要求同时搭建。

建议状态：`queued → running → validating → succeeded`。分支包括 `awaiting_manual`、`retry_wait`、`failed`；取消与过期需明确发生阶段，不能将门户已经完成的操作简单视为未执行。

完成结果示意：

```json
{
  "jobId": "demo-job-001",
  "attemptId": "demo-attempt-001",
  "status": "validating",
  "isMock": true,
  "artifactRef": "internal-artifact-reference",
  "source": {
    "insurerId": "demo-insurer",
    "productId": "demo-product",
    "productVersion": "demo-version"
  },
  "validation": {
    "status": "pending",
    "mismatches": []
  }
}
```

`status: validating` 表示拿到候选文件但尚未可交付；只有核验通过后才能标 `succeeded`。`isMock` 必须与配置和文件标识一致，真实环境不得静默返回模拟结果。

结果通过队列事件、签名回调或状态轮询其中一种返回。事件携带唯一 ID 与顺序／版本，重复或过时事件不能把已完成任务改回运行中。文件引用由服务端解析为受控文件，拒绝任意路径及任意远程 URL。

## 5. 建议错误分类

| 错误代码 | 用户可见状态 | 自动处理 |
| --- | --- | --- |
| `PARAM_INVALID` | 参数需修改 | 返回字段问题，不重试 |
| `PRODUCT_UNAVAILABLE` | 产品暂不可用 | 停止新任务，保留已有记录 |
| `AUTH_REQUIRED` | 等待重新登录 | 人工或经批准的登录流程 |
| `MFA_REQUIRED` | 需要人工处理 | 不绕过验证 |
| `PORTAL_CHANGED` | 需要检查门户 | 暂停该产品自动执行 |
| `TRANSIENT_NETWORK_ERROR` | 暂时失败／重试中 | 仅在确认不会重复提交时有限重试 |
| `RESULT_UNKNOWN` | 需要人工核对 | 先查门户结果，不盲目再生成 |
| `PDF_MISMATCH` | 文件核验失败 | 阻止交付，人工核对 |
| `WORKER_LOST` | 正在恢复／需人工 | 根据阶段和租约决定恢复方式 |

外部只返回脱敏错误和可操作提示；堆栈、凭据、会话及门户内部链接不能进入聊天。

## 6. 代码暂不可取时先完成的内容

- 用上述契约实现明确标注的 mock Worker，支持成功、等待、失败、需人工四类结果。
- H5 的输入、确认、任务详情、讲解包与跟进卡按同一契约设计。
- 测试授权、重复提交、事件重放、旧版本确认、文件错配和任务重启恢复。
- 留出真实脚本调用入口；没有真实输出时不声称“已支持某真实保司”。

## 7. 香港侧方便后要核对的内容

已有公司／产品及版本、入口函数、真实字段、运行命令和依赖、浏览器／桌面依赖、登录方式、当前人工步骤、输出文件位置／链接有效期、异常返回、平均耗时、并发限制及维护人。

在获准环境完成静态检查与一条样板运行后，按“直接复用／加封装／需修复／暂缓”分类，调整任务和排期。整个验证不要求向聊天发送明文账号或生产客户资料。
