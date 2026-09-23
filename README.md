# HB-Agent · 保险经纪智能体

当前状态：**第一版本地交互原型已可运行**。它把经纪从需求描述到后续跟进的主流程做成了一套可操作工作台；真实保司门户、香港 Python、Dify 和 APP IM 仍待接入。页面和文件会持续标注“演示／模拟”，不会让模拟结果看起来像保司官方材料。

首期目标：官方计划书生成、带出处的讲解包、轻量客户跟进卡，并在 APP 中完成问答、参数确认、任务查询和通知。

## 现在可以体验什么

- 经纪工作台、客户列表和客户详情。
- 输入“陈先生35岁不吸烟，年缴1万美元，5年缴”，整理为参数卡；未知性别保持为空，必须由经纪确认。
- 多个不同金额、吸烟状态或缴费年期会提示冲突并留空；格式、精度与范围异常不自动截短或修正。输入依据保留原文，仍是有限规则，复杂描述请手动核对。
- Schema 驱动的计划书表单、独立确认页和防重复提交。
- 异步任务状态：排队、执行、核对、完成、失败、人工接管。
- 生成带醒目模拟标识的 PDF；模型和演示解析器不计算保险利益数字。
- 生成讲解包，必须由所属经纪复核后才能导出。
- 客户跟进卡与下一步动作，使用版本号避免覆盖他人的更新。
- 运营身份处理人工队列；经纪身份和租户之间有数据隔离。
- 运营可在「产品与资料」暂停／恢复当前租户产品，填写原因并保留审计。暂停阻止新提交、将排队任务转人工，恢复不会自动重跑人工任务。

## 本地启动

要求 Node.js 24+、Python 3，并安装 `reportlab==4.4.9`。

```powershell
python -m pip install -r requirements.txt
$env:HB_PYTHON = (Get-Command python).Source
node server/index.mjs
```

浏览器打开 `http://127.0.0.1:4318`。服务只绑定本机地址，并拒绝 production 模式启动。

```powershell
node --test tests/*.test.mjs
node scripts/build_demo_pdf.mjs
```

如果电脑已安装 npm，也可以使用 `npm start`、`npm test` 和 `npm run build:demo-pdf`。

macOS / Linux 可使用隔离的 Python 环境（`tmp/` 已被 Git 忽略）：

```sh
python3 -m venv tmp/python-runtime
tmp/python-runtime/bin/python -m pip install -r requirements.txt
export HB_PYTHON="$PWD/tmp/python-runtime/bin/python"
npm start
```

完整本地验收使用 `npm run test:smoke`：通过 HTTP 确认参数，调用实际 Python 生成模拟 PDF，核对下载文件 hash，复核／导出讲解包，并重启验证文件、会话与幂等记录。脚本使用临时数据库并自动清理，不修改工作台数据，也不连接保司。它需要上述 Python 依赖；普通 `npm test` 使用替代 PDF 生成器，不依赖 Python。

若本机默认 Node 低于 24，可临时使用 `npm exec --yes --package=node@24 -- node scripts/smoke.mjs`；同样保留 `HB_PYTHON` 环境变量。此命令会先从 npm 获取 Node 24 运行时。

样例文件生成到 `output/pdf/hb-agent-demo-plan.pdf`。运行数据默认保存在 `data/prototype.sqlite`；如需从空数据开始，停止服务后删除该演示数据库即可。

## 已实现的工程边界

- HttpOnly、SameSite=Strict 演示会话；浏览器修改接口要求同源请求，Dify 工具接口使用独立短期令牌与请求签名。
- 金额使用确定性十进制定点规范化，`false` 等合法值不会被当成缺失。
- 计划书提交使用幂等键、参数快照哈希和 30 分钟确认有效期。
- 草稿和任务保存完整产品定义；产品版本或字段规则变化后需重新确认。历史任务和讲解包按原字段展示。旧版未提交草稿缺少快照时需重建。
- 任务与 PDF、讲解包、客户跟进、审计事件持久化到 SQLite。
- SQLite 任务租约与续租防止多个本地进程重复执行同一任务；真实调用前保存尝试编号，结果未落库时转人工，旧租约结果不能覆盖新状态。
- 真实任务按服务端账号引用串行执行；未知结果持续占用账号，运营核实门户结束后才能关闭释放。该本地机制尚待香港服务与真实账号映射验证。
- 文件完成前不能下载；参数不一致会阻止交付并转人工。
- 下载时复核文件 hash，拒绝存储损坏或串文件。`POST /api/extract` 必须携带当前 `productId`、`schemaVersion` 和 `text`，旧版字段定义不可继续提取。
- 真实执行中断时不盲目重试，恢复后进入人工核实。
- 适配器结果不能覆盖身份或确认快照；拒绝非法状态跳转，状态／文件和对应审计原子落库。
- 真实候选文件只能由业务服务的确定性核验器按确认快照逐字段核对后交付；目前没有任何真实产品规则，真实文件仍一律转人工。样本包到位后用 `node scripts/check-samples.mjs <目录>` 做接收检查。
- M2a-2 离线工具网关、持久合规审计／回调去重及工作台合规参数卡；真实进度仍返回 not-configured。
- M2a-2 启动拒绝任一预留 Dify 变量（`DIFY_API_URL`、`DIFY_API_KEY` 及三个应用各自的 key，见 `DIFY_ENV_VARS`），真实 Dify 接入留待 M2b。

## 接入香港现有 Python 后怎么替换

保留当前业务 API、页面、确认和审计流程，只把模拟 PDF 执行器替换为香港脚本适配器。第一批需要从香港电脑取得：脚本目录、入口参数、返回结果、依赖版本、登录方式、成功样本、失败样本和运行日志。随后先挑一家公司、一个产品完成真实沙箱验证，再逐个扩展。

正式接入前还要完成 Dify 知识库与合规层、APP IM、企业身份、密钥管理、生产数据库、对象存储、监控告警和香港部署。本原型不连接外网、不含真实客户资料，也没有假装已部署这些能力。

## 项目文档

- [分阶段交付计划](docs/delivery-plan-v1.md)：七步实施、交付效果、技术分工、排期假设和验收。
- [第一步启动包](docs/phase-01-start-pack.md)：现有 Python 能力盘点、业务走查、字段、样本与验收模板。
- [开发任务清单](docs/development-backlog.md)：任务编号、依赖、负责人角色和完成证据。
- [Python 对接契约草案](docs/python-integration-contract.md)：香港现有脚本如何接入业务服务，以及模拟和真实边界。
- [Dify 工作流实施计划](docs/dify-workflow-plan.md)：五天实施、三个工作流、接口、安全边界和验收样例。
- [M2a-2 离线工具契约与自验收](docs/m2a2-offline-tools.md)：签名与权限、接口字段、状态／文件边界、35 项离线测试与未完成部分。
- [最新接续与验收记录](docs/progress-2026-09-22.md)：本地修复、运行环境、完整流程验证和真实接入待办。
- [产品暂停与人工处理](docs/product-operations.md)：运营操作、接口、持久状态和异常处理边界。
- [架构与工程评审 v2](docs/insurance-agent-v2.md)：原方案修正、接口与安全边界。

执行顺序以 AGENTS.md §3 为准；工程边界沿用 v2。当前 M2a-2 离线实现已完成，真实香港链路与 Dify 部署仍待输入／环境。
