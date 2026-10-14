# 分段验收 Prompt 序列

以下 Prompt 按顺序发送给同一个 coding agent。每一步都要求读取当前工作树和 `docs/progress.md`，只在本步允许范围内修改，并把命令、退出码、报告路径和限制写入进度文档。前一步没有达到停止条件时，不进入下一步。

## Prompt 1：建立验收基线

```text
读取 AGENTS.md、docs/progress.md、docs/07-work-plan.md、docs/05-harness.md、docs/06-evaluation.md。检查当前工作树、package.json、测试脚本和已有报告。

本步只做审计，不修改业务代码，不修改 M4 held-out 语料、gold、分母、历史报告或模型 Prompt。输出一张 M5/M6/M7 验收差距表：每项写当前状态、证据文件、缺口、最小修复和所需命令。把审计结果追加到 docs/progress.md；没有实际执行的命令不要写 passed。

停止条件：报告必须明确哪些缺口能由代码解决，哪些必须依赖真实客户端、真实用户或部署环境；完成后停止，等待下一段 Prompt。
```

## Prompt 2：完成 M5 本地产品链

```text
只处理 M5。实现并验证准备步骤、依赖、交接请求/接受/拒绝/取消、任务历史、date-only/instant 展示、ICS UID/SEQUENCE、取消文件和 stale 导出提示。

必须复用现有 TaskCommands、ProposalService 和 ICS 编码器；准备计划冲突只能标记 needs_review，不能自动移动用户计划。导出元数据、旧导出 stale 和 case version 必须在同一事务快照中处理。补一个用户失败回归和一个真实临时 SQLite/API 测试。

先运行快速测试，再运行 npm run test:integration、npm run test:e2e、npm run check。更新 docs/progress.md，并新增 docs/m5-calendar.md，记录具体报告路径和退出码。

不要声称日历客户端兼容性已经通过。若本机没有 Outlook、Apple Calendar、Google Calendar 或独立 ICS 导入库，明确记录 M5 为 partial，列出需要的客户端名称和版本，不伪造导入结果。

停止条件：M5 本地 API/UI 链通过，确定性测试通过，外部客户端缺口被明确记录。
```

## Prompt 3：完成 M6 数据保护和恢复

```text
只处理 M6。检查并补齐本地 Origin、上传大小和真实文件头、存储路径约束、脱敏 trace、过期 AgentRun 恢复、SQLite+附件一致性备份恢复和显式事项删除。

备份必须要求调用者先停写，执行 WAL checkpoint，写入 manifest/hash；恢复必须先校验 manifest/hash，再恢复到新目录。删除必须要求当前版本、明确确认和 backupAcknowledged，并在事务内处理共享文本/附件引用，不能误删另一事项材料。

补临时 SQLite 回归：跨源请求、路径穿越、非法图片、正文不进入 trace、过期运行不提交事项、未停写备份 fail-closed、备份恢复引用一致、删除不影响共享材料。运行 npm run check、npm run test:integration、npm run test:unit、npm run test:e2e、npm run build。

新增 docs/m6-runbook.md，写明停写前提、恢复步骤、掉电/跨进程锁尚未覆盖的限制。不得删除用户数据库；测试只用临时目录。

停止条件：应用层 M6 回归和完整工程命令通过；若没有跨进程/掉电环境证据，状态保持 partial。
```

## Prompt 4：建立 M7 试点验收包

```text
只处理 M7。实现或检查一个严格的脱敏试点报告器和空模板，输入只允许匿名 participant_id、A/B/C 配对、分母、漏项、错误更新、提案错误、校正时间、失败类别、严重误解、设计问题和下一轮决策。

要求校验 8–12 位参与者、每人两个难度匹配的 A/B/C 配对、至少三项观察到的设计问题，并输出各条件分母、失败分类、C 相对 B 的配对差值和门槛判断。未知字段、个人信息、正文、自由文本访谈和缺失配对必须 fail-closed。

运行空模板：预期 exit 1、status=not_run；运行非法输入：预期 exit 2；运行合成完整输入：只验证计算控制流，不计为用户试点成绩。更新 docs/m7-pilot.md 和 docs/progress.md。

没有真实参与者数据时，绝不能写通过、改善百分比或继续决策；状态必须保持 not_run/incomplete。
```

## Prompt 5：冻结后运行完整工程验收

```text
现在只做最终验收，不再修改模型 Prompt、gold、held-out 语料、评分器阈值或历史报告。先检查前四段的变更和文档一致性。

按顺序运行：
1. npm run check
2. npm run test:unit
3. npm run test:integration
4. npm run test:eval
5. npm run eval:offline
6. npm run test:e2e
7. npm run build
8. npm run eval:m7 -- --input=evals/m7/pilot.template.json --out=<new-local-report>

所有测试使用独立临时 SQLite 和合成数据。记录每条命令的实际退出码、测试数量、报告路径和警告。若任何命令失败，先定位并增加用户失败回归，再修复；不要删测试、放宽断言或重复运行掩盖失败。

停止条件：生成一份最终验收矩阵，逐项列出 M4、M5、M6、M7 是 passed、partial 还是 not_run，并把结果追加到 docs/progress.md。只有所有任务卡 acceptance criteria 和所需外部证据都具备时才允许标记 complete。
```

## Prompt 6：生成交付结论

```text
根据当前工作树、最终命令输出和 docs/progress.md，生成最终交付结论。必须分开说明：
- 代码和确定性测试是否通过；
- M5 是否有两个实际日历客户端/导入 parser 的版本化记录；
- M6 是否有跨进程停写和掉电恢复证据；
- M7 是否有真实 8–12 人试点数据；
- M4 是否被本轮修改，及其原有 partial 结论。

不得把本地 parser round-trip、E2E、合成试点或模型直调评估写成外部客户端、真实用户或完整应用安全审计证据。给出可点击的文档、测试和报告路径，并明确下一条可执行命令。没有证据的项目写 incomplete/partial，不写“基本完成”。
```

## 发送顺序和快速迭代规则

每段完成后先检查 `docs/progress.md` 的退出码和报告路径，再发送下一段。Prompt 或模型发生任何变化时，先跑离线/虚拟时间/单案例开发测试；稳定后跑 development 集；只有冻结版本后才跑 held-out 完整三次。C28 可以用 OCR replay 只重跑 extraction，避免重复 OCR，但 replay 报告不能混入正式模型成绩。

最终可验收状态不是“所有命令都是 exit 0”，而是每个里程碑的证据都满足其 acceptance criteria；外部客户端和真实用户数据缺失时必须保留 partial/not_run。
