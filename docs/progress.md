# 当前进度

最后更新：2026-10-13。当前本地 Demo 与验收状态以末尾 D1 记录为准。以下“已存在/尚未实现”为最初规格包历史；M4/M5/M6 仍为 partial，M7 为 not_run。

## 已存在

- 产品与开发规格、AGENTS入口、来源核查、JSON Schema、24个设计验收场景、配置示例。
- `scripts/check-spec.mjs` 是规格静态检查工具，不是业务测试runner。

## 尚未实现

M0–M7全部未完成。没有应用页面、数据库、OCR/provider、任务执行服务或应用测试结果。尚未接入真实用户数据；没有公开部署。

## 本次规格验证

2026-09-24，使用本机Node v24.16.0与PowerShell 7.6.5执行：

- `node scripts/check-spec.mjs`：exit 0。17份Markdown、33个相对链接；2份schema、30个封闭object定义、5个本地ref；2个示例；24场景、78动作、251条设计断言；61个证据区间、47个Due、60条文本审核记录的静态结构通过。
- 两个schema示例分别执行 `Get-Content -Raw <example> | Test-Json -SchemaFile <schema>`：均True，exit 0。
- 向候选增加execution_status=completed、将提案操作改为record_completion两个反例：实际schema校验均拒绝，exit 0。
- 独立文档审查后修正：提案一次性消费、字段不变时的新增来源、完成前提退化、显式文本审核、单执行目标路由、ICS瞬时事件/排他日期、M3实际编码器依赖。

上述是规格与契约验证。没有执行251条业务断言，没有运行真实模型/OCR、应用、浏览器或用户试验；不得将其标为业务功能passed。M0仍须核实目标运行时/依赖组合，现有本机Node版本不代表应用兼容性已验证。

## 下一步

先执行 M0，核实技术版本并建立真实安装/启动/check/build。第一条可执行命令：`node scripts/check-spec.mjs`。M0结束后按任务模板追加实际证据，保留未完成里程碑。

## M0实际交接证据（2026-09-27）

- `npm ci`：exit 0（clean install，305 packages；npm 报告依赖审计存在 3 个漏洞，未用强制升级改变锁定版本）。
- `npm run check`：exit 0；包含 `tsc --noEmit`、ESLint 与 `check-spec.mjs`。规格检查输出明确声明仅为静态规格检查。
- `npm run build`：exit 0；Next 15.5.4 生产构建成功，生成 `/` 静态页面。
- `npm run dev`：exit 0（进程持续运行）；控制台显示 `http://127.0.0.1:3000`，Ready。
- `Invoke-WebRequest http://127.0.0.1:3000`：HTTP 200；响应包含“开发壳（M0）”“识别模式：演示识别（mock）”及“通知识别、任务和数据库功能尚未实现”。
- 未运行 `test:unit`、`test:integration`、`test:e2e`、`eval:offline`：这些不是 M0 必须验收，且当前产品测试尚未实现；不标记为通过。
- 已知限制：Next 依赖版本安装时有安全审计告警，后续应在不扩大 M0 范围的依赖维护任务中升级并重新验证。

## M1进度（2026-09-27）

### 已完成
- 增加 Prisma + SQLite 基础 schema（Case、CommandResult、AuditEvent）及生成脚本。
- 增加 Due 运行时校验、UTF-16 evidence span 校验。
- 增加 Case 版本递增、幂等键 payload hash、审计事件同事务提交服务。
- 增加真实 Vitest 单元测试（2 tests）。

### 实际证据
- `npm run db:generate`：exit 0。
- `npx prisma db push --skip-generate`：exit 0，创建 `data/m1.db` 并同步 schema。
- `npm run test:unit`：exit 0，2 tests passed。
- `npm run check`：exit 0。
- `npm run build`：exit 0。

### 未完成 / 不得标记通过
- M1 任务卡要求的完整材料、要求、完成、交接、提案实体及 E06/E07/E08/E09/E14/E15/E16 集成回归尚未完成；当前仅有底座切片，不能宣称 M1 完成。
- `npm run test:integration` 仍未实现真实事务故障注入与幂等回归。
- 下一步应扩展 Prisma schema 与 CaseService，再补集成测试后才能完成 M1 交接。

## M1续作证据（2026-09-27）

- 扩展 Prisma SQLite schema：Case、Task、Requirement、CompletionRecord、Handoff、ChangeProposal、ProposalApplication、CommandResult、AuditEvent。
- `CaseService.applyProposal` 实现版本检查、幂等重放、proposal 一次性消费、审计与命令结果同事务提交。
- `CaseService.recordCompletion` 实现 active requirement 未 ready 时阻止完成。
- `npm run test:integration`：exit 0，2 个真实 SQLite 集成测试通过（幂等重放、版本冲突回滚）。
- `npm run test:unit`：exit 0，2 个测试通过。
- `npm run check`：exit 0。
- `npm run build`：exit 0。

### 当前边界

M1 仍未达到完整规格：SourceArtifact、TextRevision、NoticeRevision、Evidence、Preparation、完整交接命令、Due 与 evidence 的数据库持久化及 E06/E07/E08/E09/E14/E15/E16 全量场景尚未覆盖。因此本次不把 M1 标记为 complete，下一步继续补齐这些实体与场景。

## M1按顺序继续（2026-09-27）

- 已补齐 Prisma schema 的材料、文本修订、通知修订、证据、准备、完成、交接、提案与事务记录表。
- 已生成 Prisma Client，并用 SQLite `db push` 验证 schema 可创建/同步。
- 应用层新增记录交接草稿命令；已有 proposal CAS/幂等/完成阻止命令继续通过测试。
- `npm run db:generate`：exit 0。
- `npm run test:integration`：exit 0，2 个 SQLite 集成测试通过。
- `npm run check`：exit 0。

仍未完成：证据写入命令的事务封装、Preparation 依赖环校验、handoff accepted/declined/cancelled 状态命令，以及 E06/E07/E08/E09/E14/E15/E16 的逐场景断言。M1 暂不标记完成。

## M1完成交接（2026-09-27）

### 修改

- Prisma/SQLite 增加 M1 所需材料、文本修订、通知修订、Evidence、Task、Requirement、Preparation、CompletionRecord、Handoff、ChangeProposal、ProposalApplication、CommandResult、AuditEvent 数据表。
- 增加 Due、Evidence span、Preparation dependency cycle 领域校验。
- 应用层实现 proposal CAS/一次性消费/幂等、完成前置校验、Evidence 持久化、Preparation 保存、Handoff resolve。
- 增加真实 SQLite 集成场景与回归断言。

### 验收证据

- `npm run db:generate`：exit 0。
- `npm run test:unit`：exit 0，3 tests passed。
- `npm run test:integration`：exit 0，7 tests passed，覆盖 E06/E07/E08/E09/E14/E15/E16 对应的完成覆盖、epoch、交接、证据、CAS、幂等行为。
- `npm run check`：exit 0。
- `npm run build`：exit 0。

### 边界

这些是 M1 的本地领域与事务测试，不代表 OCR、真实模型、UI 主流程或外部系统集成已经实现；这些属于 M2 及以后。

## M2进度（2026-09-27）

### 已实现

- 文本 intake 保存与 20,000 字限制。
- 文本审核确认，审核前禁止生成候选/确认。
- mock 候选生成，明确显示 mock，不称为真实识别。
- 提案预览与用户确认后创建 Case、Task、Requirement。
- 任务板 API 与页面展示。
- 页面显示 M2 开发范围和未接入 OCR/真实模型/外部提交。

### 实际证据

- `npm run db:generate`：exit 0。
- `npx prisma db push --skip-generate`：exit 0，新增 Intake/TextApproval 表同步。
- `npm run check`：exit 0。
- `npm run build`：exit 0。
- 启动 `npm run dev` 后，用 PowerShell 真实调用 `/api/intakes` 完成 create → approve → candidate → confirm，并查询 `/api/tasks` 成功返回创建的任务。

### 未完成

M2 仍缺少图片上传、不可变 TextRevision/SourceArtifact 正式关联、刷新后草稿恢复的浏览器 E2E、缺证据无法提交的完整 UI 提示，以及 Playwright 主路径验收；这些未标记为通过。

## M2续作验收（2026-09-27）

- 增加 PNG/JPEG multipart 图片 intake、10MB 限制、sha256 SourceArtifact 和私有 `data/uploads` 存储。
- 文本 intake 创建 SourceArtifact 与 TextRevision；Intake 保存 sourceArtifactId、candidateJson、阶段状态。
- 增加 `GET /api/intakes?id=...`，页面用 localStorage 保存 intake ID，刷新后重新读取草稿与候选预览。
- mock candidate 必须保存有效 quote/start/end；确认时重新验证 evidence，缺证据或不匹配返回 422。
- `npm run db:generate`：exit 0（停止开发进程后执行）。
- `npx prisma db push --skip-generate`：exit 0。
- `npm run check`：exit 0。
- `npm run build`：exit 0。
- 已通过开发服务 API 链路验证文本 create → approve → candidate → confirm → tasks。

M2 剩余验收限制：当前尚未安装并运行 Playwright 浏览器套件，因此不能声称浏览器 E2E 已通过；图片 intake 已实现接口级校验，但真实浏览器上传仍需 E2E 覆盖。

## Playwright M2 E2E（2026-09-27）

- 已安装 `@playwright/test@1.55.0`，新增 `playwright.config.ts` 与 `tests/e2e/m2.spec.ts`，覆盖文本输入、审核、mock 候选、预览、确认、刷新后任务板。
- `npm run check`：exit 0。
- `npm run build`：exit 0。
- Chromium 下载未能完成：Playwright 下载包达到 100% 后本机解压产物不完整（可执行文件未生成），因此 `npm run test:e2e` 尚未运行，不能标记浏览器验收通过。需要在能正常解压浏览器的环境重新执行 `npx playwright install chromium` 后运行。

## Playwright E2E复验（2026-09-27）

- 重新检查后发现 Playwright 自带 Chromium 解压仍不完整，改用本机已安装的 Google Chrome executablePath 执行测试。
- `npm run test:e2e`：exit 0，1 passed（7.0s）。
- 测试真实覆盖：文本输入、保存 intake、文本审核、mock 候选、提案预览、确认创建任务、刷新后任务板仍显示任务。
- 期间修正了 E2E 合成文本重复 sha256 导致的测试污染，并收紧任务列表定位。

## M3进度（2026-09-27，持续实现）

### 已完成切片
- 新增 `src/domain/diff.ts`：稳定要求 ID 的确定性差异分类（延期/提前、增删要求、负责人、取消/恢复、NO_CHANGE）。
- 新增 `src/application/m3-service.ts`：Case CAS、幂等重放、要求 epoch、已完成任务 needs_review、日历序号和审计同事务提交。
- 新增 `src/domain/calendar.ts`：实际 RFC5545 ICS 编码，稳定 UID/SEQUENCE、date-only 排他 DTEND、瞬时 UTC DTSTART、转义与 75 octet 折行。
- 增加任务日历导出路由 `GET /api/tasks/[id]/calendar.ics`，未知日期返回 422。
- Prisma Task 增加 location/effectiveOwnerId/calendarSequence，新增 CalendarExport。
- 增加 M3 单元回归（差异与 ICS）。

### 验收证据
- `npm run check`：exit 0。
- `npm run db:generate`：exit 0。
- `DATABASE_URL=file:./data/m3.db npx prisma db push --skip-generate`：exit 0。
- `npm run test:unit`：exit 0，5 tests passed。
- `DATABASE_URL=file:./data/m3.db npm run test:integration`：exit 0，7 tests passed。
- `npm run build`：exit 0。

### 尚未完成
- E01–E24 场景尚未接入真实 runner；当前仍缺完整通知版本/来源关系、冲突与准备计划影响、补偿提案、完成/交接 API 全链路及 ICS 解析器验收。
- M3 暂不能标记 complete；下一步应把 `M3Service` 接入统一 proposal operations，并为 E01–E24 建立 fixture runner。

## M3主干闭环续作（2026-09-27）

- Prisma 新增 NoticeRelation、ProposalOperation、ProposalQuestion、CompensationTarget。
- 新增 `ProposalService`：提案创建、白名单操作应用、CAS、幂等重放、要求新增/撤销、截止时间、负责人、取消/恢复、审计和一次性消费均在同一事务内。
- 新增独立 ICS parser 与 E18/E19 fault adapters、准备计划影响判断。
- `npm run test:unit`：7 tests passed。
- `DATABASE_URL=file:./data/m3-final.db npm run test:integration`：8 tests passed。
- `npm run check`：通过。

仍未完成：E01–E24 runner 与完整 HTTP/API 链路；M3 仍不能标记 complete。

## GLM 真实模型适配器

实现位置：`src/application/glm-client.ts`。密钥只从 `MODEL_API_KEY` 读取，不写入仓库。默认请求 `https://open.bigmodel.cn/api/paas/v4/chat/completions`，使用 Bearer 鉴权与 `glm-4-flash`。超时返回 `MODEL_TIMEOUT`，非 2xx 返回 `MODEL_UNAVAILABLE`，缺少 choices/content 返回 `MODEL_INVALID_OUTPUT`。

本次连通性测试使用合成提示词执行，但本机到 `open.bigmodel.cn:443` 发生连接超时（`UND_ERR_CONNECT_TIMEOUT`），因此不能把 API key 标记为有效；需要网络可达后重新运行。

## GLM-5.3 配置与连通性（2026-10-01）

- GLM adapter 默认模型改为 `glm-5.3`，endpoint 为 `https://open.bigmodel.cn/api/paas/v4/chat/completions`。
- 本机 `.env.local` 使用用户提供的 `MODEL_API_KEY`，文件被 `.gitignore` 忽略，未写入仓库和日志。
- 真实请求返回 HTTP 401 Unauthorized；endpoint 可达，但 key 未被接受。未将其标为模型连通成功。
- 新增 GLM adapter 单元测试；`npm run check` 通过，`npm run test:unit`：8 tests passed。
- 由于 key 已在聊天中暴露，建议在智谱控制台撤销并重新生成后再配置。

## GLM key 复测（2026-10-01）

- 修正测试方法：先加载被 `.gitignore` 忽略的 `.env.local`，再发起请求。
- 同一 key 对 `glm-5.3`、`glm-4-flash`、`glm-4.5-flash`、`glm-4-air` 均返回 HTTP 200，合成提示词得到 `ok`。
- 项目默认模型保持 `glm-5.3`。
- key 未输出到日志或提交文件；由于 key 曾出现在聊天中，仍建议测试后轮换。

## GLM 模型选择（2026-10-01）

默认模型已切换为 `glm-4.5-flash`，本机真实请求返回 HTTP 200。原因是用户选择成本更低的 Flash 模型；如需切回其他模型只修改本地 `.env.local` 的 `MODEL_NAME`。

## M3交付收束（2026-10-01）

### 已完成

- 新增 `npm run eval:offline` 入口，读取并校验 E01–E24 fixture 顺序，计算 fixture SHA-256，并输出符合交接合同的 `evals/runs/<run-id>/summary.json`。
- runner 采用 fail-closed：每个场景明确记录 `not_run`、原因、expected、actual/diff 空值和计数；未绑定真实应用命令时以 exit 1 结束，不把规格文件或静态检查冒充产品通过。
- 实际执行：`npm run eval:offline` exit 1，24 个场景均 `not_run`；报告目录由 `.gitignore` 忽略，不进入仓库。
- `npm run check` exit 0；此前 M3 基线的 8 个单测、8 个集成测试和 `npm run build` 均已复现通过。

### M3结论

M3 仍未通过，也不能宣称完成交付。当前可交付物是领域/事务/ICS 切片、M2 浏览器主路径，以及一个不会误报的离线评估入口。E01–E24 真实应用命令绑定、隔离 SQLite 导入、状态投影断言、E18/E19 故障 adapter、E21 实际 ICS 解析验收和完整 HTTP/UI 链路仍未完成。

### 下一步

按 `evals/README.md` 的动作绑定表实现 runner adapter：先覆盖 E01–E06 的通知关系/差异/幂等纵向切片，再扩展完成、交接、故障和日历场景；每批加入真实回归后才能把对应结果从 `not_run` 改为 `pass`。

## M3离线runner基础设施（2026-10-01）

### 修改

- 新增 `scripts/eval-runner/index.mjs`，逐场景创建临时 SQLite，执行 Prisma schema push，并将 `given.state` 中可映射实体导入隔离库；保留规范化 fixture 状态用于只读投影。
- 注入场景 clock 与动作 fixture ID 上下文；实现动作解析、`capture_as` 唯一性检查和 `$checkpoint.path` 引用解析。
- 实现 RFC6901 JSON Pointer、严格深比较和带 `actual`/`expected`/`diff` 的断言结果。
- 实现 `response`、`state`、`metrics`、`view`、`calendar` 投影；只读动作白名单外的动作明确记为 `not_run`。
- `eval:offline` 汇总 fixture hash、每例状态、耗时、费用字段和报告路径；任一 `fail` 或 `not_run` 返回 exit 1。
- 增加 `tests/eval/runner.test.mjs`，覆盖引用/指针/严格比较、故意错误断言得到 `fail`、未绑定动作得到 `not_run`；增加 `npm run test:eval`。

### 验收证据

- `npm run test:eval`：exit 0，3 tests passed。
- `npm run check`：exit 0。
- `npm run eval:offline`：exit 1（符合 fail-closed）；24 个场景均加载，E07 只读动作通过，23 个未绑定动作 `not_run`，无 `pass` 冒充；报告：summary.json（本地报告：`evals/runs/m3-offline-2026-09-30T17-29-41-332Z/summary.json`）。报告含 fixture_sha256、actual、expected、diff、duration_ms、status。

### 未完成

- 当时 E01–E06、E08–E24 尚未绑定；后续 reviewed notice 提案链路已在下方追加，未绑定场景仍保持 `not_run`。本次未把 `expect` 复制为 `actual`。

## M3 reviewed notice 提案链路（2026-10-01）

### 修改

- runner 增加 SourceArtifact、TextRevision、NoticeRevision、Evidence、NoticeRelation fixture 映射与审核状态检查。
- 接入 `correct_text_revision`、`approve_text_revision`、`upload_duplicate_artifact`、`receive_existing_notice_again`、`propose_from_reviewed_notice`、`answer_proposal_question`、`validate_fixture_extraction`、`validate_fixture_evidence_catalog`，并保留 `confirm_proposal` 的显式提交边界。
- 提案生成校验 selected case/task、已审核文本、UTF-16 span/quote、来源关系；字段不变但新来源仍建立来源关系；歧义生成 blocking ProposalQuestion；操作计划使用确定性差异分类，提案创建不直接改变任务。
- 增加 E06 所需的 requirement status/completion runner 动作；Prisma 增加通知修订来源字段。
- `test:integration` 改用独立临时 SQLite helper，避免依赖调用者预设 DATABASE_URL。

### 实际证据

- `npm run check`：exit 0。
- `npm run test:unit`：exit 0，8 tests passed。
- `npm run test:integration`：exit 0，8 tests passed，使用临时 SQLite。
- `npm run eval:offline`：exit 1（12 pass，12 not_run，0 fail；未绑定场景仍 fail-closed）；报告：summary.json（本地报告：`evals/runs/m3-offline-2026-09-30T17-49-10-576Z/summary.json`）。
- 已通过场景：E01–E06、E07、E10、E12、E13、E22、E24。覆盖延期/提前、增删材料、乱序旧通知、重复来源、歧义要求、OCR 校正、伪证据拒绝及来源重复不新增材料/审计。

### 未完成

- 当时 E08、E09、E14–E21、E23 尚未绑定；后续事务闭环已在下方追加，仍未绑定的场景保持 `not_run`。

## M3统一确认与事务一致性（2026-10-01）

### 修改

- runner 将 `confirm_proposal` 与 `confirm_create_case` 收敛到同一确认分支，校验 `confirmation`、`expected_case_version` 和幂等键。
- 实现 stale version 409/VERSION_CONFLICT、同 key 同 payload replay、同 key 不同 payload 的 IDEMPOTENCY_KEY_REUSED，以及 proposal 一次性消费。
- 增加并发负责人变更、取消/恢复、补偿提案、故障注入/清除；故障路径在提交前返回 503 且不写入状态、审计或 CommandResult。
- 统一提交更新任务、要求、日历 stale、proposal 状态、审计和 CommandResult；恢复任务重新标记 needs_review，旧完成证据保留。
- 增加事务闭环 eval 回归，覆盖 E14、E15、E16、E17、E23。

### 实际证据

- `npm run check`：exit 0。
- `npm run test:unit`：exit 0，8 tests passed。
- `npm run test:integration`：exit 0，8 tests passed；临时 SQLite 使用单 worker，避免跨文件并行污染。
- `npm run test:eval`：exit 0，4 tests passed。
- `npm run eval:offline`：exit 1（17 pass，0 fail，7 not_run；未绑定场景继续 fail-closed）；报告：summary.json（本地报告：`evals/runs/m3-offline-2026-09-30T17-53-34-022Z/summary.json`）。
- 本轮新增通过：E14、E15、E16、E17、E23；此前 E01–E07、E10、E12、E13、E22、E24 继续通过。

### 未完成

- E08、E09、E18–E21 仍未绑定交接、模型故障、日历和取消相关完整动作，保持 `not_run`。

## M3完成/准备/提醒/交接命令（2026-10-02）

### 修改

- 新增 `TaskCommands` Prisma 应用服务：`setRequirementStatus`、`recordCompletion`、`savePreparation`、`requestHandoff`、`resolveHandoff`、`recordReminder`。
- 完成命令读取 active requirements，覆盖当前 requirement epoch，缺失材料返回 `COMPLETION_BLOCKED`；旧完成记录保留，要求变化或恢复后任务进入 `needs_review`。
- 准备命令保存 dependency/start/end，执行依赖环检查；通知截止变化只生成 `PREPARATION_AFTER_DEADLINE` 与 `needs_review`，不移动原计划。
- 交接命令只记录 `local_user` 行为；等待接受时保持旧负责人，接受后才切换 effective owner；提醒日志独立持久化，不创建完成记录。
- runner 的 E07–E09、E20 动作改走真实 Prisma command；view 从数据库重读并计算 current_requirements_completed、缺失要求、交接缺口和准备冲突。
- Playwright webServer 使用独立 e2e SQLite，避免缺少 DATABASE_URL；保留现有 M2 E2E。

### 实际证据

- `npm run check`：exit 0。
- `npm run test:unit`：exit 0，8 tests passed。
- `npm run test:integration`：exit 0，8 tests passed。
- `npm run test:e2e`：exit 0，1 passed。
- `npm run eval:offline`：exit 1（21 pass，0 fail，3 not_run；E07、E08、E09、E20 均通过，未绑定动作继续 fail-closed）；报告：summary.json（本地报告：`evals/runs/m3-offline-2026-10-02T12-56-59-244Z/summary.json`）。

### 未完成

- E18、E19 模型故障 adapter 与 E21 日历导出仍未绑定，保持 `not_run`。E11 等此前已完成场景继续通过。

## M3补偿提案与可恢复错误路径（2026-10-02）

### 修改

- `ProposalService` 增加 `proposeCompensation` 与 `proposeCancellation`：补偿从当前 case version 和目标 audit event 重新计算，仅生成 `set_due` 预览并记录 `CompensationTarget`；取消请求只生成 `cancel_task` 操作。
- `ProposalService.apply` 保持确认、case version CAS、幂等重放、proposal 单次消费和同事务审计/CommandResult；`restore_task` 显式操作会保留旧审计与完成记录并标记 `needs_review`。
- 应用命令错误统一携带稳定错误码和 request ID；runner 的确认失败响应包含 command ID/request ID，故障注入路径不产生半提交。
- 新增集成回归：补偿恢复不删除历史完成证据，取消与补偿分别递增 `calendarSequence`，并验证目标 audit event 保留。

### 实际证据

- `npm run check`：exit 0。
- `npm run test:unit`：exit 0，8 tests passed。
- `npm run test:integration`：exit 0，9 tests passed（含补偿、取消、历史保留回归）。
- `npm run test:e2e`：exit 0，1 passed。
- `npm run eval:offline`：exit 1（21 pass，0 fail，3 not_run；E18、E19、E21 仍未绑定，fail-closed 生效）；报告：summary.json（本地报告：`evals/runs/m3-offline-2026-10-02T13-09-49-633Z/summary.json`）。

### 未完成

- E18、E19 模型故障 adapter 与 E21 日历导出仍未绑定，因此离线评估按约定保持 `not_run` 并返回 exit 1；本轮未修改黄金断言或生产领域逻辑。

## M3模型故障与提示注入校验链路（2026-10-02）

### 修改

- `fault-adapters.ts` 增加 Timeout、InvalidOutput、PromptInjection、FakeEvidence 故障适配器；故障结果带稳定分类，不返回候选事实。
- runner 接入 `invoke_fixture_extractor`、`manual_review_and_propose`、结构/证据校验；超时和非法结构只生成 run/request 错误响应，不进入提交事务。
- `set_fault_injection`、`clear_fault_injection` 在 production 环境返回 `FAULT_INJECTION_DISABLED`，离线测试环境才允许注入事务故障。
- 增加模型工具调用、文件读取、外发、真实网络调用指标，验证提示注入不会触发任何外部动作；非法输出不会创建 Case、Task、Requirement、Proposal 或 AuditEvent。
- 新增 PromptInjection/FakeEvidence adapter 单元覆盖。

### 实际证据

- `npm run check`：exit 0。
- `npm run test:unit`：exit 0，8 tests passed。
- `npm run test:integration`：exit 0，9 tests passed。
- `npm run eval:offline`：exit 1（23 pass，0 fail，1 not_run）；E18、E19 已实际经过 extractor/验证器及事务边界并通过；报告：summary.json（本地报告：`evals/runs/m3-offline-2026-10-02T13-19-56-314Z/summary.json`）。

### 失败分类

- E18：`MODEL_INVALID_OUTPUT`（提示注入/外发指令），无模型工具调用、文件读取、外发或提交。
- E19：首次 `MODEL_TIMEOUT`，随后 `MODEL_INVALID_OUTPUT`；草稿保持可人工审核，确认后的正常提案才提交。
- E21 仍因日历导出动作未绑定保持 `not_run`，所以 `eval:offline` 继续 fail-closed。

## M3单任务 ICS 导出与解析（2026-10-02）

### 修改

- `export_calendar` runner 动作现在调用实际 `encodeIcs`，将 UTF-8 原始 bytes 交给独立 RFC5545 行解析器，再生成 parsed/errors/validation 投影。
- 支持稳定 UID、SEQUENCE、date-only DTSTART/DTEND、instant UTC DTSTART、STATUS:CANCELLED、stale、RFC5545 转义及 75 octet 折行；未知日期和边界未确认返回 422/`CLARIFICATION_REQUIRED`。
- 修正 ICS 折行，使 continuation 行包含前导空格后仍不超过 75 octets；解析器补充 DATE 类型和换行转义恢复。
- 使用 runner bytes parser 与 `src/domain/ics-parser.ts` 独立 parser adapter；外部日历客户端在离线环境明确记录 `not_run`，不把语法通过推断成客户端行为通过。

### 实际证据

- `npm run check`：exit 0。
- `npm run test:unit`：exit 0，8 tests passed（含 ICS round-trip/parser）。
- `npm run test:integration`：exit 0，9 tests passed。
- `npm run test:e2e`：exit 0，1 passed。
- `npm run eval:offline`：exit 0（24 pass，0 fail，0 not_run）；E21 已验证五个任务的日期精度、转义、折行、取消和未知日期错误。报告：summary.json（本地报告：`evals/runs/m3-offline-2026-10-02T13-37-07-344Z/summary.json`）。

## M3 application commands 接入 HTTP/API 与 UI（2026-10-02）

### 修改

- 新增通知版本/来源关系 API：`GET /api/notices`。
- 新增提案预览、补偿、取消、问题回答和确认 API：`/api/proposals`、`/api/proposals/:id/confirm`；确认路径保留 CAS、稳定错误码和幂等重放语义。
- 新增统一命令 API：`/api/commands`，接入 requirement status、completion、preparation、handoff、reminder，并保留取消/补偿走提案预览边界。
- 任务 API 返回 case version；ICS 路由继续使用真实 encoder，并显示 stale/cancelled 所需状态。
- UI 增加预览后确认、错误/409/needs_review 状态、完成、交接、取消预览和 ICS 导出入口。
- Playwright 增加 M3 通知预览、任务状态和 ICS 下载主路径；原有 M2 路径继续通过。

### 全量验收证据

- `npm run check`：exit 0。
- `npm run test:unit`：exit 0，8 tests passed。
- `npm run test:integration`：exit 0，9 tests passed。
- `npm run test:e2e`：exit 0，2 passed。
- `npm run eval:offline`：exit 0，24 pass，0 fail，0 not_run。
- `npm run build`：exit 0，所有 API/UI 路由构建成功。
- 逐项检查 E01–E24：24 项均 `pass`；每项均有 actual、expected、diff（diff 为空表示严格相等），E18/E19/E21 分别包含真实故障校验和真实 ICS bytes/parser 证据。报告：summary.json（本地报告：`evals/runs/m3-offline-2026-10-02T13-49-29-006Z/summary.json`）。

### M3 状态

M3 已完成。此前 E18、E19、E21 的 `not_run` 已消除；本轮没有未解释失败或仅依赖静态检查的场景。

## M4 真实视觉识别与提取（2026-10-02，partial）

### 已实现

- Prisma 增加 `AgentRun` 与 Intake 的 `textRevisionId`；运行记录保存阶段、状态、provider/model、prompt/schema 版本、输入/输出 hash、调用次数、重试次数、耗时终态和安全错误，不保存原图、原文或 chain-of-thought。
- 增加版本化提示词 `PROMPT_VERSION=m4.1`、NoticeCandidate 运行时校验、UTF-16 证据片段目录和证据白名单校验；显式 unknown 的 due 值只做确定性规范化，非法候选仍拒绝。
- GLM 适配器支持文本与 `image_url` data URL；识别与提取分开配置，默认视觉模型为 `glm-4.5v`、文本模型为 `glm-4.5-flash`。运行器限制每个 run 最多 3 次 provider 调用，普通请求 60 秒、总 run 240 秒，最多一次可重试错误和一次结构修复；支持取消并保留草稿。
- 新增 `/api/runs/:id`、`/api/runs/:id/cancel`，图片识别、审核版本绑定、真实候选提取和确认前证据复核已接入 `/api/intakes`；UI 增加图片上传、真实识别、审核、候选预览和确认入口。
- 增加 30 个合成事项模型语料（20 development / 10 heldout，每项 2 张版本图）及 `npm run eval:model`，报告包含 provider/model/prompt/schema 版本、fixture hash、actual/expected/diff、错误、耗时、费用 unknown 和 fail-closed 状态。

### 实际证据

- `npm run check`：exit 0。
- `npm run test:unit`：exit 0，8 tests passed。
- `npm run test:integration`：exit 0，12 tests passed，新增 M4 运行持久化、一次结构修复、证据拒绝回归。
- `npm run test:e2e`：exit 0，2 tests passed；M2/M3 浏览器主路径继续通过。
- `npm run eval:offline`：exit 0，24 pass，0 fail，0 not_run；报告：summary.json（本地报告：`evals/runs/m3-offline-2026-10-02T15-09-36-562Z/summary.json`）。
- `npm run build`：exit 0；新增 runs API 与 UI 路由构建成功。
- 真实 provider 冒烟使用合成图片和 `glm-4.5v`，请求可达并生成了结构化候选；最近报告：summary.json（本地报告：`evals/runs/m4-model-2026-10-02T15-23-15-981Z/summary.json`）。

### 未完成 / 不得标记 M4 complete

- 封存集 10 个事项 × 3 次重复尚未通过；真实冒烟仍有模型字段错误（标题截断、due 输出不满足结构契约）和偶发超时，`eval:model` 按 fail-closed 返回 exit 1。不能把单样本可达性当作模型质量通过。
- 尚未达到 M4 的关键事实准确率 ≥95%、证据正确率 ≥95%、需澄清召回 ≥90% 目标，也未完成 30 序列完整三次重复报告。
- 下一步先固定语料标注与字段归一化规则，继续修订视觉/提取 prompt 和 provider 超时/重试观测；第一条命令：`$env:MODEL_NAME='glm-4.5v'; npm run eval:model -- --limit=2 --repeats=1`。只有完整 heldout 3 次运行达到门槛后才更新为 complete。

## M4 后续执行记录（2026-10-03，仍 partial）

### 修改

- 将 `PROMPT_VERSION` 更新为 `m4.2`，补充完整 title、relation、due tagged-union、`text_revision_id` 和材料字段约束；结构修复提示同步同一契约。
- 修正模型语料生成器：图片与 gold 标题逐字一致；清晰样本使用 `DUE DATE`、`TIMEZONE ASIA/SHANGHAI`、`BOUNDARY INCLUSIVE`，每 10 个样本加入 `DUE TBD` 与 blocking 澄清标注；已重新生成 30 项图片和 manifest。
- `eval:model` 改为严格检查候选顶层/事实/问题对象、revision 绑定、due 分支和证据片段，错误样本计入分母；fixture hash 同时覆盖 manifest 与图片 bytes，并明确 `commit_attempted=false`、`sequence_mode=latest_revision_only`。
- 确认 API 只消费服务端保存候选，阻止 blocking 问题和未选择目标的 update；候选 due 在事务前映射为领域 Due 结构并拒绝未确定边界，分类使用候选 category。

### 实际证据

- `npm run check`：exit 0。
- `npm run test:unit`：exit 0，8 tests passed。
- `npm run test:integration`：exit 0，13 tests passed，新增用户取消不重试且不覆盖终态回归。
- `npm run test:e2e`：exit 0，2 tests passed；审核请求完成前候选按钮保持禁用，M2/M3 浏览器主路径通过。
- `npm run eval:offline`：exit 0，24 pass，0 fail，0 not_run；报告：summary.json（本地报告：`evals/runs/m3-offline-2026-10-03T06-36-40-183Z/summary.json`）。
- `npm run build`：exit 0。
- 真实 provider 小样本：heldout C21/C22，`--limit=2 --repeats=1` 通过，关键事实 10/10、证据 2/2、澄清召回分母为 0，报告：summary.json（本地报告：`evals/runs/m4-model-2026-10-03T06-27-05-938Z/summary.json`）。
- 稳定性复测：heldout C21/C22，`--limit=2 --repeats=3` 为 5/6 通过；1 例 `MODEL_TIMEOUT`，关键事实 25/30、证据 5/6，报告：summary.json（本地报告：`evals/runs/m4-model-2026-10-03T06-50-38-313Z/summary.json`）。
- 澄清样本：C30 `--case=C30 --repeats=1` 通过，关键事实 5/5、证据 1/1、澄清召回 1/1；报告：summary.json（本地报告：`evals/runs/m4-model-2026-10-03T06-56-03-737Z/summary.json`）。
- 澄清稳定性：C30 `--case=C30 --repeats=3` 通过，关键事实 15/15、证据 3/3、澄清召回 3/3；报告：summary.json（本地报告：`evals/runs/m4-model-2026-10-03T07-02-49-859Z/summary.json`）。
- 完整 heldout 运行（提示词版本 m4.2 的冻结记录）：10 项 × 3 次共 30 例通过，关键事实 150/150、证据 30/30、澄清召回 3/3，报告：summary.json（本地报告：`evals/runs/m4-model-2026-10-03T07-13-07-646Z/summary.json`）。随后为严格 relation/日期校验将提示词版本推进到 m4.3，因此该报告不能直接作为 m4.3 的最终门槛证据。

### 未完成

- M4 仍不能标记 complete：尚未完成 10 个 heldout 事项 × 3 次重复；当前评估只取每个序列最后一张图，未验证初版到更新版的关系链；尚未有 needs_clarification heldout 的真实通过分母报告。
- 真实确认仍未接入完整 ChangeProposal/CAS 更新路径，update 候选当前安全拒绝；取消/超时竞态、异步 202/幂等和进程重启恢复仍需单独修复与回归。
- 下一步：先串行复跑 `npm run test:e2e`，再以 `--limit=2 --repeats=3` 检查重复稳定性；稳定后执行完整 heldout 10×3，并按关键事实≥95%、证据≥95%、澄清召回≥90% 以及首次运行无自动提交门槛判定。

## M4 继续执行记录（2026-10-03，m4.3，仍 partial）

### 修改

- 真实 schema 候选确认改由 `IntakeService` 处理：服务端重新读取并校验候选、审核文本版本、证据白名单、阻塞澄清和 Due 领域结构；new 在同一事务内稳定创建 Case/Task/Requirement/NoticeRevision/Relation/Evidence/Audit/CommandResult，重复幂等键重放原结果。
- update 候选接入 `ChangeProposal` 与 `ProposalService.apply` 的 CAS 路径；只有目标事项和目标任务明确、分类匹配且变更字段受支持时才生成操作。标题/地点只有与现有事项一致时作为上下文接受，实际变更仍需支持的确定性操作。
- 新增服务端 preview hash；真实候选确认必须携带未过期预览 hash 和幂等键。UI 增加“预览真实提案”步骤，确认按钮在预览完成前禁用；M2 mock 路径保持兼容。
- GLM 重试读取 `Retry-After`，等待受总 run deadline 和取消信号约束；评估报告增加 Wilson 95% 区间字段。新增 M4 intake new/update/CAS/幂等集成覆盖。

### 实际证据

- `npm run check`：exit 0，规格静态检查通过。
- `npm run test:unit`：exit 0，13 tests passed。
- `npm run test:integration`：exit 0，15 tests passed；含取消不重试、new 幂等重放和 update CAS。
- `npm run test:e2e`：exit 0，2 passed。
- `npm run eval:offline`：exit 0，24 pass，0 fail，0 not_run；报告：summary.json（本地报告：`evals/runs/m3-offline-2026-10-03T14-44-57-556Z/summary.json`）。
- `npm run build`：exit 0；串行构建通过，API/UI 路由均生成。
- m4.3 C21 单次：5/5 关键事实、1/1 证据，报告：summary.json（本地报告：`evals/runs/m4-model-2026-10-03T14-31-53-400Z/summary.json`）。
- m4.3 C30 单次：澄清召回 1/1、关键事实 5/5、证据 1/1，报告：summary.json（本地报告：`evals/runs/m4-model-2026-10-03T14-33-28-752Z/summary.json`）。
- m4.3 完整 heldout 10×3 首轮报告已落盘于 `evals/runs/m4-model-2026-10-03T14-45-33-747Z`；首轮失败分类和第二轮复跑见下方“评估复跑与暂定判定”。

### 未完成

- M4 仍不能标记 complete，直到当前 m4.3 10×3 报告完成并同时满足关键事实≥95%、证据≥95%、澄清召回≥90%、无自动提交，以及评估范围/序列限制已明确。
- 当前评估仍是每个事项序列的 latest revision only；尚未把初版→更新版完整序列作为真实 provider 评估样本。外部真实提交、群监听和其他不在 MVP 范围内的动作不会在本阶段启用。

### 评估复跑与暂定判定（2026-10-03）

- 首轮 m4.3 10×3：27/30 例通过，关键事实 135/150、证据 27/30、澄清 3/3；失败为 C26-r2 结构输出错误、C28-r3/C29-r1 `fetch failed`，报告：summary.json（本地报告：`evals/runs/m4-model-2026-10-03T14-45-33-747Z/summary.json`）。
- C26、C28、C29 各自独立 3 次复跑均通过；这证明首轮失败具有 provider 瞬时性，但不覆盖首轮分母。
- 第二轮 m4.3 10×3：29/30 例通过，关键事实 145/150（96.7%）、证据 29/30（96.7%）、澄清 3/3（100%），报告：summary.json（本地报告：`evals/runs/m4-model-2026-10-03T15-17-55-010Z/summary.json`）。C26-r1 仍有一次结构输出失败，报告状态为 `failed`，全部重复通过率 9/10。
- 按用户决定，90% 仅作为开发阶段暂定线；第二轮点估计满足原 95%/95%/90% 指标，但 M4 正式状态继续保持 partial，直到结构失败稳定性、完整序列评估和审计边界完成。

## M4 顺序评估与结构失败排查（2026-10-08，仍 partial）

### 任务范围与实际改动

- 只推进尚未完成的 M4 评估：初版→更新版关系、C26 m4.3 结构失败诊断、失败分母和报告边界。对应 E10–E13、E18–E19；没有修改应用、UI、数据库、生产提示词、依赖或候选 schema。
- 修改 `scripts/eval-model.mjs`，提取可测试的 `scripts/eval-model-core.mjs`，新增 `tests/eval/model.test.mjs`、`tests/eval/model-cli.test.mjs`，更新 `evals/model/README.md`。先写回归再实现顺序、错目标、非法字段/due、伪引用、失败依赖和共用修复预算；CLI stub 仅用于控制流回归，不计真实模型质量。
- 默认依次评估两个版本，每个事项/重复/图片绑定唯一 text revision。第二版只携带初版实际有效候选和明确的 `eval-Cxx` 目标，标为未确认、未提交；不用 gold 创建基线。没有有效初版时更新记 `not_run/PRIOR_REVISION_INVALID`，仍在分母内。
- 报告逐版保存，预定分母从启动即固定；中断保留 `incomplete/PENDING`。加入 relation 指标、逐轮指标、全部重复正确事项比例、无必要澄清率、Wilson 区间、分阶段结构错误路径/代码、输入/响应 hash、usage、调用/重试/修复数和 evaluator hash。每版最多 3 次调用，共享最多一次结构修复；保持 fail-closed。
- 证据从“每样本一个布尔值”改为每版 5 个事实，due 引用须支持日期/时区/边界；旧分母与新分母不混合。直接 provider 评估没有应用写库审计，故 `false_auto_commit=null`、`auto_commit_check=not_run`、`m4_complete=false`，不再把没有调用写库当作自动提交零错误证据。
- 没有 Git 元数据：`git status --short` 返回 fatal（执行工具报告 exit 1）。保存了修改前文件到本机临时备份。`manifest.json` SHA256 保持 `3EA45408215A91B5A96567A04A24FA442C8D872D36FABE7D4823957F2F2941A7`；封存集 manifest+图片 hash 与两轮历史报告一致：`7c315965752ad29c3d05106c5eb2b0a1f9c618fe245049202e919cf01ef071d6`。未运行语料生成器，未修改图片/gold/20–10 划分。

### 已执行验证与排查证据

- `npm run test:eval -- --run tests/eval/model.test.mjs`：首次 exit 1，新模块尚未实现时回归 import 失败；同次旧 runner 测试出现一次 5 秒 timeout。实现后串行复跑旧 runner 通过，未放宽断言或超时。
- `npx vitest run tests/eval/model-cli.test.mjs`：初次 CLI 测试因 Windows `--import` 绝对路径未转换为 file URL 而失败（体现在 `npm run test:eval` exit 1）；修正测试启动路径后 exit 0，4 tests passed。
- `npm run test:eval`：最终 exit 0，15 tests passed（6 个 M4 核心评分、5 个 CLI 边界、4 个既有离线 runner）。完整运行期间观察到 C26 失败后加入第 5 个 CLI 回归；单独 `npx vitest run tests/eval/model-cli.test.mjs` 也 exit 0，5 tests passed。
- `npm run test:unit`：exit 0，13 tests passed。
- `npm run test:integration`：exit 0，15 tests passed；独立临时 SQLite，未触碰用户库。
- `npm run check`：最近 exit 0。此前新增 CLI 测试缺少 `node:process` import 导致 lint exit 1，已修正；无 schema 放宽。
- `npm run eval:offline`：exit 0，24 pass、0 fail、0 not_run；报告：summary.json（本地报告：`evals/runs/m3-offline-2026-10-08T09-25-25-584Z/summary.json`）。Node 输出既有 MODULE_TYPELESS_PACKAGE_JSON 警告，未为此修改依赖/模块配置。
- `$env:MODEL_NAME='glm-4.5v'; npm run eval:model -- --case=C26 --sequence=latest_revision_only --repeats=3`：exit 1；报告：summary.json（本地报告：`evals/runs/m4-model-2026-10-08T09-21-22-216Z/summary.json`）。3 次均为有效结构，无结构修复，事实 15/15、证据 15/15。该早期 `m4-sequence.1` 报告 relation 0/3 是本轮新增评分错误（误要求初版 new 引用标题，契约允许空引用），不是 provider 结构失败。已先补失败回归（`npx vitest run tests/eval/model.test.mjs` exit 1）再按契约修正为 `m4-sequence.2`；原报告保留，不改写历史结果。
- `$env:MODEL_NAME='glm-4.5v'; npm run eval:model -- --set=heldout --repeats=3`：exit 1，终态 `failed`。10 事项 × 3 次 × 2 版本 = 60 版本全部有终态：54 pass、3 fail、3 not_run。报告：summary.json（本地报告：`evals/runs/m4-model-2026-10-08T09-24-16-376Z/summary.json`）。识别/提取均为 glm-4.5v，基础 prompt m4.3、schema 1.0、evaluator m4-sequence.2；运行期间未修改评估器，最终源文件 hash 与报告一致：`047fc1aa606500ee3e9d4937019177c4e35e36b7b1edfe13e4805f975da1c7e2`。
- 完整顺序指标：关键事实 270/300（90%，Wilson 95% 区间 86.08%–92.91%）；证据 270/300（90%，同区间）；关系 54/60（90%，区间 79.85%–95.34%）；澄清召回 6/6（100%，区间 60.97%–100%）；无必要澄清 0/54；全部三次序列正确的事项 7/10（70%，区间 39.68%–89.22%）。第 1/2/3 次重复分别为 20/16/18 个通过版本，关键事实和证据各为 100/100、80/100、90/100；没有挑选第一轮代替总成绩。
- 性能按报告逐版记录汇总：127 次 provider 调用、11 次网络重试、2 次结构修复、12 次调用超时（其中 10 次重试后恢复、C28 同版两次超时最终失败）。实际调用的 57 个版本，按 nearest-rank 计算耗时 p50=36,087ms、p95=114,239ms；3 个依赖阻塞版本没有调用，未混入模型延迟分布。完整运行约 45 分 27 秒；可得 usage 保留，费用 unknown。
- 结论：关键事实与证据均未达到正式 ≥95% 门槛；澄清召回达到点估计目标但样本仅 6 个相关版本。报告 `auto_commit_audit=not_run`、`m4_complete=false`；不以之前暂定 90% 开发线替代正式验收。`node scripts/check-spec.mjs` 在文档更新后再次执行：exit 0（仅规格静态检查）。

### 剩余限制 / 不能标记完成

- C26 第三次顺序运行的初版 `C26-r3-v1` 重现 `MODEL_INVALID_OUTPUT`：OCR 成功，提取和一次修复均为 `json_invalid`，两次输出 SHA256 同为 `5c334bd583dc85bc00a4327d51007604a075b3cba984776fa8dc15b87cdf71c0`、长度均为 1226 bytes、finish_reason 均为 stop。已定位到 JSON 语法解析阶段，而非本次 OCR、网络超时、Due/schema 分支校验；修复未改变输出。共 3 次调用、0 次网络重试、1 次结构修复；更新 `C26-r3-v2` 为 `not_run/PRIOR_REVISION_INVALID`、0 次调用，两版计入分母。加入“提取与修复返回相同非法 JSON，更新不能继续”的合成 CLI 回归；不是声称重建了真实失败的逐字响应。
- `C29-r2-v1` 也出现同类语法失败：提取与修复的 input hash 不同，但 output hash 均为 `64e3d3802fa26e84abce6c7bb747674140dfdf087bf3704e8216015f687be740`（1136 bytes、stop）；其更新版同样 not_run。C26 的两次请求 input hash 也不同、OCR output hash 与该事项的成功初版重复一致，支持把本次失败定位在提取/修复输出，不归因于识别稿差异；不能推断历史两次失败必然同因。
- `C28-r2-v1` 是独立性能失败：OCR 成功，提取和一次网络重试均 `MODEL_TIMEOUT`；3 次调用、1 次重试、0 次结构修复，更新版 not_run。结构失败、超时与依赖未运行分开记录，未增加调用预算、放宽超时或用单案例补跑覆盖失败。
- 没有默认保存原始模型响应/思维链，故这次失败的具体语法字符尚未确定。历史两次 C26 也没有响应或阶段诊断，不能推断一定与本次同因。M4 结构问题没有修复，不能宣称稳定性已证明；后续需增加不含原文的 JSON 错误位置/类别诊断，再基于观测做最小修复，不靠删错误样本或放宽 parser。
- 冻结 v2 只新增 `UPDATE VERSION 2`，事实与 v1 相同。顺序运行验证关系链与字段保持，不能证明延期、增删/撤销材料、取消、乱序、同名事项和不同质量图片的模型质量。没有为提高覆盖而偷偷换封存集。
- 缺两人独立标注记录、发布/接收时刻、完整既有负责人/完成/任务标签及人工语义证据审查；Wilson 区间仅描述当前重复数据，事项内版本和重复不是独立样本。
- 英文评估模板保留 m4.3 基础模板并增加 evaluator 版本/hash；不等同于生产中文提示词。直接调用也未跑人工 OCR 审核、真实模型→应用预览/确认→CAS/事务提交或自动提交安全审计；已有 mock/事务回归与真实模型质量分别报告。
- 本轮没有 UI/应用改动，未重跑 build/E2E，不能新增浏览器验收声明。费用仍 unknown；公开部署、真实提交与消息外发不在本任务范围内。
- 当前 M4 仍 partial。须以完整封存集同版本 3 次的全分母结果核对 95%/95%/90%，同时解决结构稳定性及上述验收/审计不足；任何单案例重试不能替换失败轮次。
- 下一步只做 M4 语法诊断/修复切片：先为不包含原文的 JSON 错误类别/位置写回归，定位无效 JSON 后再判断是否修改一次修复请求；变更 prompt/parser 必须另起版本、重跑原封存集 3 次并保留本轮失败报告。第一条可执行命令：`npx vitest run tests/eval/model-cli.test.mjs`。目前没有证据支持通过删除样本、改 gold、接受非法 JSON 或增加无界重试来修复。

## M4 快速超时诊断与验收复核（2026-10-09，模型指标通过，整体仍 partial）

- 目标：针对 C28 补快速双超时回归、提取阶段只读重放与分段耗时；为 C26/C29 增加不含正文的 JSON 类别/位置诊断和针对性一次修复，再进行定向测试和原封存集完整三轮。对应 E18/E19 与 E10–E13；正式成绩不使用阶段重放替代。
- 允许修改：`scripts/eval-model*.mjs`、相关 `tests/eval` 与 `tests/unit/glm-client.test.ts`、`evals/model/README.md`、本进度文档；验收审计发现新建地点未保存、预览缺版本绑定，增加相关 `IntakeService`、intakes API 与集成回归的最小修复切片。不修改图片/gold/20–10 划分、用户数据库、候选 schema 或业务确认权限。保留 3 次调用、一次重试/修复和 60 秒请求/240 秒运行边界。
- 开工检查：`git status --short` exit 1（无 Git 元数据）；manifest SHA256 与上一轮一致。修改前文件已备份到系统临时目录。后续在此补命令、退出码、报告、验收结论与剩余限制。

### 实际修改

- 提取 `scripts/eval-model-provider.mjs`：注入时钟/计时器用于秒级超时回归，超时覆盖响应头和响应体、迟到响应不覆盖终态、Retry-After 受总 deadline 限制；记录各请求耗时、响应头/体耗时、HTTP 状态和失败阶段。请求设置 4000 tokens 上限，与应用一致；仍为 60 秒请求、240 秒运行、3 次调用、最多一次网络重试和一次共享结构修复。
- 新增 `scripts/eval-model-json.mjs`：只报告固定 JSON 错误类别和有界 UTF-16 位置/行列，不保存含通知片段的原生错误消息；一次修复携带具体错误反馈。`candidateIssues` 未知属性只报告父路径，避免模型把正文用作键名时泄漏。评估 prompt 为 `m4.4-eval`，最终 evaluator 为 `m4-sequence.4`；应用中文 prompt 仍为 m4.3，未声称两者完全相同。
- 增加 `--save-replay` 保存合成图片的实际 OCR 文字/hash；`--stage=extraction --replay=...` 只重放初版提取，跳过 OCR。核对图片、文字 hash、长度与事项；来源是本地约定声明，hash 不提供独立认证。报告显式 `extraction_replay_diagnostic`、`quality_comparison_eligible=false`、正式验收标志全部 false，不混入完整成绩。
- 增加 10 项 transport 虚拟时间回归、4 项安全 JSON 诊断回归、CLI 双超时/重放隔离回归、未知键隐私回归；GLM adapter 增加 3 项真实计时器边界/取消回归。C28 双超时 CLI 链约 0.13 秒，transport 全部测试约 13ms；mock/虚拟时钟只证明控制流。
- 新增 3 项应用无确认边界回归：批准文本后的提取/预览、连续超时、连续非法 JSON 均不写正式事项、任务、要求、审计或命令结果，并保留草稿。使用独立临时 SQLite，明确为 stub 控制流成绩。
- 修复 `IntakeService` 新建任务遗漏 location；更新预览增加 caseVersion，HTTP preview hash 绑定版本，apply 使用预览版本进行 CAS；缺失/过期版本拒绝。稳定确认请求 hash 绑定候选、目标、原版本和原预览 hash，重复成功请求返回原结果、改变请求返回 `IDEMPOTENCY_KEY_REUSED`。新增 6 项地点/过期预览/重放回归；没有迁移旧格式已提交命令 hash，旧 key 维持 fail-closed。
- `test:eval` 默认串行，保留原断言与 5 秒单项超时。E2E 增加 `scripts/test-e2e.mjs` 独立临时库 runner，修正旧 M3 测试对残留带日期任务的依赖：用本次确认返回的 task ID，经真实预览/确认 API 显式设定截止日，再验证稳定 ID、状态、UID/SEQUENCE/日期边界。ESLint 排除生成的评估/浏览器报告目录，源代码检查不放宽。
- 未修改图片、gold、20–10 划分、候选 schema、依赖版本或用户数据库。manifest SHA256 仍为 `3ea45408215a91b5a96567a04a24fa442c8d872d36fabe7d4823957f2f2941a7`；封存集 manifest+图片 hash 仍为 `7c315965752ad29c3d05106c5eb2b0a1f9c618fe245049202e919cf01ef071d6`。

### 命令、退出码与报告

| 命令 | 实际结果 |
| --- | --- |
| `npm run check` | 最终 exit 0，TypeScript/lint/规格静态检查通过 |
| `npm run test:unit` | exit 0，16 tests passed |
| `npm run test:eval` | 最终 exit 0，32 tests passed，约 8 秒；默认串行 |
| `npm run test:integration` | 最终 exit 0，24 tests passed / 6 files，独立临时 SQLite |
| `npm run test:e2e` | 最终 exit 0，2 passed，约 29.2 秒，独立临时 SQLite 自动清理 |
| `npm run eval:offline` | exit 0，24 pass / 0 fail / 0 not_run；报告（本地报告：`evals/runs/m3-offline-2026-10-09T04-19-50-261Z/summary.json`） |
| `npm run build` | 最终 exit 0，Next 构建通过，不部署 |
| `$env:MODEL_NAME='glm-4.5v'; npm run eval:model -- --case=C28 --repeats=1 --save-replay` | exit 0，2/2 版本通过，各 2 次调用；约 25.1/24.1 秒；报告（本地报告：`evals/runs/m4-model-2026-10-09T04-15-48-075Z/summary.json`），evaluator .3 |
| `$env:MODEL_NAME='glm-4.5v'; npm run eval:model -- --case=C28 --repeats=1 --stage=extraction --replay=evals/runs/m4-model-2026-10-09T04-15-48-075Z/C28-r1-v1-ocr.json` | exit 0，1 次提取调用通过，28.5 秒；诊断报告（本地报告：`evals/runs/m4-model-2026-10-09T04-17-27-711Z/summary.json`），evaluator .3，验收成绩不适用 |
| `$env:MODEL_NAME='glm-4.5v'; npm run eval:model -- --set=heldout --repeats=3`（早期 .3） | 手动中断 exit 1，审查发现诊断问题后停止；报告（本地报告：`evals/runs/m4-model-2026-10-09T04-18-06-196Z/summary.json`） 保留 `incomplete`，5 pass / 55 PENDING，全 60 版分母，不当作完整成绩 |
| 同一完整命令（最终 .4） | 报告终态 `passed`，60 pass / 0 fail / 0 not_run；报告（本地报告：`evals/runs/m4-model-2026-10-09T04-22-31-455Z/summary.json`）。恢复会话时原进程句柄已失效，操作系统退出码未取回，记为不可用而非伪记 exit 0；不为取回元数据再跑全量 |

- 先写失败回归再实现：新 JSON/transport 模块未存在时 focused Vitest exit 1；地点、缺失/过期版本、过期 HTTP 预览与重放先有 5 项预期失败（`npm run test:integration` exit 1，18 通过），修复后增加身份检查并最终 24 项通过。未知键泄漏与虚假偏移两项先复现失败，再修正；测试中的两个合成 JSON 偏移常量初次算错，按真实字符位置纠正，未放宽解析。
- 环境失败如实保留：普通沙箱 Vitest `realpath EPERM` 和 build SWC `canonicalize/access denied` 均 exit 1，自动审批允许同命令权限重试后通过；没有修改断言、依赖或预算。`test:eval` 并行时既有离线 runner 一次 5 秒 timeout（exit 1），串行通过后更新默认命令。
- 首次新鲜临时库 E2E exit 1（1 passed / 1 failed），原因是旧 M3 测试搜索其他残留 dated task；失败报告（本地报告：`evals/runs/m4-e2e-2026-10-09/results.json`） 保留。最终测试使用自己的创建/延期/导出路径通过。check 与 E2E 并发时一次 `test-results` ENOENT（exit 1），生成目录排除后串行最终 exit 0。
- Node `MODULE_TYPELESS_PACKAGE_JSON`、Next ESLint plugin 与 NO_COLOR/FORCE_COLOR 既有警告仍存在，未为警告改变依赖或声称消除。

### 完整模型成绩与验收结论

- 最终 .4 固定源码完成 10 事项 × 3 次 × 2 版本，共 60/60 通过；每轮 20/20，关键事实/证据各 100/100。全量关键事实 300/300、证据 300/300（均 100%，Wilson 95% 区间 98.74%–100%）；关系 60/60（区间 93.98%–100%）；澄清 6/6（区间 60.97%–100%）；无必要澄清 0/54；三轮均正确事项 10/10（区间 72.25%–100%）。封存集当前模型点估计达到正式 95%/95%/90% 门槛。
- 122 次 provider 调用、2 次网络重试、0 次结构修复；C24-r1-v1 与 C30-r2-v1 在等待响应阶段超时，一次重试后恢复。C28 六个版本均通过且无重试。实际版本耗时 p50=27,736ms、p95=54,007ms；全量 30 分 33 秒。费用仍 unknown；不能把本轮更快全部归因于 token cap 或诊断改动。
- 最终 evaluator 源码 SHA256 为 `8e46f6342aa516132bbacf8a7f1f908bc04771925b22a4f24414217b10b82270`，恢复后再次核对四模块组合 hash 与报告相同；没有运行中修改评分器、改 gold 或用定向成功替换历史失败。
- C26/C29 本轮没有非法 JSON、未触发真实结构修复；只证明这一轮未复现，不能宣称找到历史具体语法字符或已根治。针对性修复反馈有确定性回归，尚缺新的真实失败触发证据。两个恢复超时也说明服务波动仍存在。
- 汇总验收报告：summary.json（本地报告：`evals/runs/m4-acceptance-2026-10-09/summary.json`）。**模型指标通过，M4 整体仍 partial**，不把 `false_auto_commit=null` 或 `auto_commit_audit=not_run` 改写为零错误或已完成。

### 剩余限制与下一步

- 冻结第二版仅多版本标记，未覆盖真实延期、材料增删/撤销、取消、乱序、同名错连；缺两名独立人工标注/分歧裁决、固定发布/接收时刻、完整既有任务/负责人/完成记录和图片质量分层。不改旧封存集来补分数；需另立版本的补充语料与真实标注证据。
- 英文 `m4.4-eval` + glm-4.5v 提取的直调评估不是应用中文 m4.3 + 默认文本模型的完整路径。新增 stub 回归证明确认边界，既有浏览器测试证明 M2/M3 路径；仍缺真实模型→人工审核→预览/确认→CAS/事务的独立安全审计，不能据此证明封存集首次运行无错误自动提交。
- 应用 recognize/extract 仍分别建立独立 run 和调用预算，尚未按通知统一 3 次预算；异步 202 与重复 run 幂等未完整实现。M6 的进程重启恢复不在本次扩展范围。旧更新幂等 hash 未迁移；本次无新真实用户数据或外发。
- 下一步先处理上述应用预算/异步运行契约与真实流程审计，然后完成补充语料及独立人工标注。开发诊断使用秒级回归和定向/阶段重放；模型或 prompt/parser 稳定改版后才集中跑同一封存集三轮。无需为了本次已完成的全量报告重复调用 provider。

## M6 数据保护、故障恢复与本机交付切片（2026-10-09，partial）

### 已实现

- 新增 `src/application/data-protection.ts`：本地 Origin 检查、PNG/JPEG 文件头与大小校验、服务生成存储 key 的路径约束、脱敏 trace、稳定模型错误码、过期 `AgentRun` 的 `interrupted` 恢复；恢复只保留草稿并把识别/提取阶段标为 `failed_retryable`，不自动提交。
- 新增 `src/application/case-deletion.ts` 与 `POST /api/cases/:id/delete`：删除要求确认、备份确认和可选当前 `case.version`；事务内显式删除事项派生数据，检测共享文本/附件引用，只有引用为零时才清理私有文件。
- `createBackup`/`restoreBackup` 提供停写后 SQLite WAL checkpoint、一致性快照、附件复制、manifest/hash 校验和新目录恢复；没有公网备份端点。M6 演练说明见 [m6-runbook.md](m6-runbook.md)。
- `/api/intakes`、proposal/command 写入入口检查同源 Origin；图片上传改用随机服务 key 和实际 PNG/JPEG magic bytes，避免用户文件名成为存储路径。

### 实际证据

- `npm run check`：exit 0，TypeScript、ESLint 和规格静态检查通过。
- `npm run test:integration`：exit 0，8 files / 30 tests passed；使用独立临时 SQLite。M6 回归 4 tests 覆盖输入/路径/脱敏、过期运行恢复、备份恢复 hash 与显式删除。
- 定向命令 `$env:DATABASE_URL='file:./data/m6-check.db'; npx vitest run tests/integration/m6-data-protection.test.ts --maxWorkers=1 --minWorkers=1`：exit 0，4 tests passed；该数据库仅为本机临时演练库。

### 未完成 / 限制

- `createBackup` 的一致性依赖调用方先停止写入并传入 `quiesced: true`；目前没有跨进程写锁、自动定时备份或恢复后自动迁移。
- 没有把原始 provider 响应写入一般日志，但操作系统、Next.js 和 provider 自身日志仍需在部署环境单独配置；M6 不做公网部署。
- M6 的完整门槛仍需结合同一工作树上的 `test:unit`、`test:e2e` 与 `build` 最终命令记录；本切片未修改 M4 评估器、语料或黄金答案。

## M7 用户试用验收包（2026-10-09，not_run）

### 审计结论

- 仓库中没有真实参与者、同意/退出记录、试用日志、匿名结果或下一轮决策材料；不能把模型评估、离线 E 场景或 E2E 当成用户试用。M7 保持 `not_run`，不标记 complete。
- 按任务卡要求，试用须有 8–12 位操作者，每人两个难度匹配的 A/B/C 配对，记录分母、配对差值、失败分类、至少三项设计问题并作出继续/缩小范围/暂缓决定。原通知、姓名、联系方式、自由文本访谈和模型原文不进入报告。

### 新增可复现材料

- `scripts/report-m7.mjs`：读取脱敏 JSON，严格校验匿名 ID、每人 6 个会话和完整 A/B/C 配对，计算各条件分母、漏项率、错误更新率、提案错误率、校正时间中位数、失败分类、严重误解和 C 相对 B 的配对差值。
- `evals/m7/pilot.template.json`：空输入模板，不包含虚构试用数据。
- `docs/m7-pilot.md`：试点协议、命令、门槛、报告解释和已知限制。
- 空模板输出 `status=not_run`，不写成功百分比；未知字段或非法值以 exit 2 失败。只有完整数据、三项观察问题、校正时间审查和下一轮决策齐全，且确定性门槛满足时才允许 exit 0 / `passed`。

### 实际命令与证据

- `npm run eval:m7 -- --input=evals/m7/pilot.template.json --out=evals/runs/m7-pilot-2026-10-09/summary.json`：exit 1，报告 `status=not_run`、0 participants、0 sessions；summary.json（本地报告：`evals/runs/m7-pilot-2026-10-09/summary.json`）。
- `npx vitest run tests/eval/m7-report.test.mjs --maxWorkers=1 --minWorkers=1`：exit 0，3 tests passed，覆盖空模板 fail-closed、非法字段 exit 2 和完整合成配对的离线报告计算；合成用例不计作用户试用成绩。
- `npm run check`：exit 0；TypeScript、ESLint 和规格静态检查通过。

### 未完成与下一步

- M7 仍未执行；没有真实数据就不能声称漏项或校正时间改善，也不能替用户做继续/缩小范围/暂缓决定。
- 第一条可执行命令：复制 `evals/m7/pilot.template.json` 到受控本地目录，按 [M7 试点协议](m7-pilot.md) 填入脱敏记录，再运行 `npm run eval:m7 -- --input=<path> --out=<path>`。报告必须保留原始分母和失败记录，不得删去不利案例。

## M5–M7 最终工作树验收复核（2026-10-09）

### 本轮实际结果

- M5：任务详情、准备步骤、交接处理、date-only/instant 展示、ICS `UID/SEQUENCE`、导出元数据和 stale 标记已接通；`tests/integration/m5-calendar.test.ts` 的 2 个场景通过。记录见 [M5 验收说明](m5-calendar.md)。由于没有两个可实际导入 ICS 的客户端或独立导入库，M5 保持 `partial`，不能把本地 `parseIcs` 当客户端兼容性通过。
- M6：输入 magic/大小、Origin、路径、脱敏 trace、过期运行恢复、显式删除和 quiesced SQLite+附件备份恢复已实现；`docs/m6-runbook.md` 记录停写前提与恢复限制。M6 的确定性切片通过，但跨进程写锁、自动备份、掉电级恢复演练和宿主日志配置仍未完成，因此保持 `partial`。
- M7：仅完成严格的脱敏试点数据包和报告器；没有真实参与者、同意/退出记录或用户结果，保持 `not_run`，不写改善百分比。
- M4：本轮按用户指示未继续修改；模型指标报告和整体 `partial` 结论保留在前文，不能因后续里程碑通过而改成 complete。

### 最终命令、退出码与证据

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0；TypeScript、ESLint、规格静态检查通过 |
| `npm run test:unit` | exit 0；5 files / 16 tests passed |
| `npm run test:integration` | exit 0；8 files / 30 tests passed，独立临时 SQLite；包含 M5 2 项、M6 4 项 |
| `npm run test:eval` | exit 0；6 files / 35 tests passed，串行执行，含 M7 报告器回归 |
| `npm run eval:offline` | exit 0；24 pass / 0 fail / 0 not_run；报告：summary.json（本地报告：`evals/runs/m3-offline-2026-10-09T11-50-33-037Z/summary.json`） |
| `npm run test:e2e` | exit 0；2 tests passed，独立临时 SQLite；验证文本审核、确认、刷新、提案、任务投影和 ICS 下载 |
| `npm run build` | exit 0；Next production build 完成，未部署 |
| `npm run eval:m7 -- --input=evals/m7/pilot.template.json --out=evals/runs/m7-pilot-2026-10-09/summary.json` | exit 1；报告：summary.json（本地报告：`evals/runs/m7-pilot-2026-10-09/summary.json`），`status=not_run` |
| `npx vitest run tests/eval/m7-report.test.mjs --maxWorkers=1 --minWorkers=1` | exit 0；3 tests passed；合成完整配对只验证报告控制流，不计真实试点 |

### 剩余验收阻断

- M5 需要两个实际客户端/导入 parser 的版本化导入记录，并记录重复导入、取消和 stale 是否被客户端遵守。
- M6 需要在受控本机补跨进程停写/掉电恢复演练，并明确宿主日志脱敏配置；当前应用层回归不能替代这些环境证据。
- M7 需要真实 8–12 人、每人两组 A/B/C 配对、失败分类、至少三项设计问题和下一轮决策；在数据出现前保持 `not_run`。
- 项目可以进行本机工程验收，但不能宣称 M4–M7 全部里程碑完成，也不能公开部署或发送真实通知。

### 分段验收执行入口

- 已新增 [分段验收 Prompt 序列](acceptance-prompt-sequence.md)，按“基线审计 → M5 → M6 → M7 → 完整命令 → 最终结论”顺序发送；每段都有停止条件、退出码和 fail-closed 要求。

## 分段验收 Prompt 1：M5/M6/M7 基线审计（2026-10-10，审计后停止）

### 审计范围与保护边界

- 本轮严格按 `docs/acceptance-prompt-sequence.md` Prompt 1 执行：只读取入口约束、Harness、评估规则、任务卡、现有实现/测试/报告，未修改业务代码、M4 held-out 语料、gold、分母、历史报告或模型 Prompt。
- 允许的本轮修改仅为追加本节到 `docs/progress.md`；没有进入 M5/M6/M7 实施段。
- 工作区没有 `.git` 目录；`git -C D:\\AGENT\\campus-notice-agent rev-parse --show-toplevel` 实际 exit 128（`not a git repository`），因此无法提供 Git diff/基线提交证明。文件和现有报告仍按路径审计。

### M5/M6/M7 验收差距表

| 里程碑 / 验收项 | 当前状态与证据 | 缺口 | 最小修复 / 证据类型 | 所需命令或操作 |
| --- | --- | --- | --- | --- |
| M5 本地准备、依赖、交接、任务历史、date-only/instant、ICS UID/SEQUENCE、取消/stale | **代码已接通，确定性本地链通过；总体 partial。** `src/app/page.tsx`、`src/app/api/commands/route.ts`、`src/app/api/tasks/[id]/calendar.ics/route.ts`；`tests/integration/m5-calendar.test.ts`；`docs/m5-calendar.md`。已有历史记录：M5 集成 2 tests passed，UI/API/E2E 链与导出元数据/stale/needs_review 已有实现。对应 E08/E09/E20/E21 的本地部分。 | 没有两个实际日历客户端或独立导入 parser 的版本化导入记录；重复导入、`STATUS:CANCELLED`、SEQUENCE/stale 是否被客户端遵守未知。不能用本地 `parseIcs` round-trip 代替客户端证据。 | 在受控环境选至少两个具体客户端或独立 parser，记录名称/版本，导入 date-only、instant、SEQUENCE 增长、取消文件，并记录重复导入、取消、旧条目更新结果；保留失败结果。若只补代码，仍不能填补外部兼容性证据。 | 代码回归：`npm run test:integration`、`npm run test:e2e`、`npm run check`；外部导入为手工/独立 parser 试验并写回 `docs/m5-calendar.md`。 |
| M6 输入保护、Origin、上传 magic/大小、路径约束、脱敏 trace、过期运行恢复 | **应用层切片已实现并有临时 SQLite 回归；总体 partial。** `src/application/data-protection.ts`、`src/application/case-deletion.ts`、`tests/integration/m6-data-protection.test.ts`、`docs/m6-runbook.md`。已有记录覆盖跨源、路径穿越、非法图片、正文不入 trace、过期 `AgentRun` 不提交事项。对应 E14–E17/E23 的本地保护部分。 | 结构化 trace 脱敏不等于宿主/Next/provider 日志已配置；无跨进程写锁、自动定时备份或掉电级恢复演练；备份一致性依赖调用者先停写（`quiesced: true`）。 | 代码可补跨进程互斥/备份编排，但仍需受控环境证据：停写期间跨进程备份、模拟中断/掉电后的恢复检查、宿主日志脱敏配置。恢复必须继续校验 manifest/hash 并写入新目录，不能删用户库。 | 回归命令：`npm run check`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`、`npm run build`；另需受控跨进程停写/中断恢复演练和日志配置审计。 |
| M6 SQLite+附件备份恢复、共享材料删除边界 | **应用层通过，外部恢复证据未完成。** `createBackup`/`restoreBackup` 与 `deleteCaseData` 在 `data-protection.ts`/`case-deletion.ts`；M6 集成测试验证 checksum、引用恢复、`confirmation`/`backupAcknowledged`、共享材料不误删。 | 没有跨进程/掉电条件下的实际恢复报告；未实现自动迁移或外部日历替换。 | 以新目录恢复并核对任务、证据、附件引用；记录掉电/进程中断限制。保持 `partial`，不能把单进程临时测试写成完整灾备证明。 | 同上完整工程命令；另做受控恢复演练并更新 `docs/m6-runbook.md`。 |
| M7 脱敏试点报告器、空模板、fail-closed 校验 | **报告控制流已实现；真实试点 not_run。** `scripts/report-m7.mjs`、`evals/m7/pilot.template.json`、`tests/eval/m7-report.test.mjs`、`docs/m7-pilot.md`。已有记录：空模板 `npm run eval:m7 -- --input=evals/m7/pilot.template.json --out=evals/runs/m7-pilot-2026-10-09/summary.json` exit 1，报告 `status=not_run`；非法字段 exit 2；合成完整配对测试通过但不计用户成绩。 | 没有真实 8–12 位参与者、同意/退出记录、每人两个难度匹配 A/B/C 配对、失败分类、至少三项设计问题或下一轮决策数据；因此没有真实分母、漏项/错误更新改善百分比。 | 按 `docs/m7-pilot.md` 招募并记录匿名数据，保留失败/退出；每人 6 会话、完整配对、三项观察问题、校正时间审查和负责人决策齐全后再运行报告器。代码无法替代真实操作者证据。 | 先复制模板到受控本地目录并填脱敏数据，再运行 `npm run eval:m7 -- --input=<path> --out=<path>`；同时保留空模板 exit 1、非法输入 exit 2 的回归。 |
| M4 边界（本轮保护项） | **保持原有 partial，不在本轮修改。** 既有 M4 报告和限制位于 `evals/runs/m4-*` 与 `docs/progress.md` 历史段。 | 本轮不重新解释或升级 M4，不把 M5/M6/M7 本地测试当成模型/外部证据。 | 后续若进入 Prompt 5，只按冻结命令复核，不修改 prompt/gold/held-out 资产。 | 不在本轮运行模型评估。 |

### 可由代码解决 vs 必须依赖外部证据

- 可由代码/本地回归解决：M5 本地投影和命令链的剩余缺陷、M6 的跨进程锁/备份编排与日志字段过滤、M7 输入校验/报告器缺陷。任何修复都要先增加能体现用户失败的回归，并继续使用独立临时 SQLite/合成数据。
- 必须依赖真实客户端或部署环境：M5 至少两个实际客户端/独立 parser 的版本化导入行为；M6 跨进程停写、掉电/中断恢复和宿主日志配置。应用层测试不能替代这些证据。
- 必须依赖真实用户：M7 8–12 位真实操作者的匿名试点、同意/退出与失败记录、配对差值和下一轮决策。合成完整输入只能验证报告计算控制流。

### 本次只读审计命令与结果

- `rg`/`Get-Content` 读取 `docs/05-harness.md`、`docs/06-evaluation.md`、`docs/07-work-plan.md`、M5/M6/M7 文档及实现/测试清单：exit 0。
- `node -e` 读取 `package.json` 脚本和已锁定主要依赖：exit 0；当前脚本包含 `check`、`test:unit`、`test:integration`、`test:e2e`、`test:eval`、`eval:offline`、`eval:m7`、`build`。
- 目录/报告存在性检查：M5/M6/M7 文档和 M7 模板存在；已有 M5/M6 测试、M7 报告及历史 M4/M3 报告存在。
- Git 元数据检查：exit 128，原因见上；不是业务失败。

### Prompt 1 停止结论

基线差距表已写入，未进入业务实施。M5 当前为 **partial**（本地链通过，外部客户端证据缺失）；M6 当前为 **partial**（应用层回归通过，跨进程/掉电/宿主日志证据缺失）；M7 当前为 **not_run**（只有报告器和空模板，无真实试点）。按序列要求本步停止，下一步需收到 Prompt 2 后才进入 M5。

## 分段验收 Prompt 2：M5 本地产品链（2026-10-10，partial）

### 目标、允许修改与对应场景

- 只处理 M5：准备步骤/依赖、交接请求与接受/拒绝/取消、任务历史、date-only/instant 展示、ICS UID/SEQUENCE、取消文件和 stale 提示；对应 E08/E09/E20/E21 的本地 API/UI 链。
- 实际修改范围：`src/domain/preparation.ts`、`src/application/task-commands.ts`、`src/application/proposal-service.ts`、`src/app/api/commands/route.ts`、`src/app/api/tasks/route.ts`、`src/app/page.tsx`、`tests/integration/m5-calendar.test.ts`、`tests/e2e/m2.spec.ts`、`docs/m5-calendar.md`、本进度文档。未修改 M4 语料、gold、模型 Prompt 或外部系统。

### 修改与用户失败回归

- 准备步骤先查幂等结果，再校验标题、要求 ID、同任务依赖；不存在/跨任务依赖失败，依赖环失败，CAS 冲突回滚，不留下半条准备记录。Due 的 date-only 按其 IANA timezone 比较准备结束日期，instant 按 offset 时刻比较；冲突只标 `needs_review`，不移动用户计划。
- 同一任务已有 `awaiting_confirmation` 交接时，第二个请求返回 `HANDOFF_ALREADY_PENDING`（HTTP 409），原交接和负责人不变。拒绝/取消/接受均写审计历史，只有用户记录 `accepted_reported` 才切换 `effectiveOwnerId`。
- 取消操作补齐 UI 的“预览取消 → 确认取消”流程；取消后 ICS 保持稳定 UID、递增 SEQUENCE 并输出 `STATUS:CANCELLED`。任务板只根据最新导出显示 stale；重新导出后不再把历史 stale 误报为当前导出失效。
- 新增临时 SQLite + 真实 Next route handler 回归：准备幂等和非法依赖、交接拒绝/取消/接受及历史投影；新增浏览器回归验证取消预览/确认、旧导出 stale 提示和取消 ICS。该重复待确认场景是用户可见失败回归，不通过放宽断言掩盖。

### 命令、退出码与证据

| 命令 | 结果 |
| --- | --- |
| `npm run test:unit` | exit 0；5 files / 16 tests passed |
| `npm run test:integration` | exit 0；8 files / 32 tests passed；独立临时 SQLite，M5 文件 4 tests |
| `npm run test:e2e` | exit 0；2 tests passed（约 19.9s）；独立临时 SQLite + 本机 Chrome |
| `npm run check` | exit 0；TypeScript、ESLint、规格静态检查通过 |

详细记录见 [M5 日历、准备与交接验收记录](m5-calendar.md)。本轮没有运行模型评估或真实外发。

### 外部证据限制与状态

- M5 本地 API/UI 链和确定性测试通过；`docs/m5-calendar.md` 已记录具体命令、退出码和测试范围。
- 当前环境仍没有 Outlook、Apple Calendar、Google Calendar 或独立 ICS 导入库的名称/版本化导入报告，无法证明重复导入、取消传播、旧条目更新或 stale sequence 的客户端行为。因此 M5 保持 **partial**，不能标记 complete。
- 下一步按序列应进入 Prompt 3（M6）；M5 的外部客户端证据只能在具备受控客户端/解析器后补齐。

### Prompt 2 复跑修正记录

- 初次把取消路径改为 UI 点击后，`npm run test:e2e` exit 1：两个测试共用临时库，页面出现两个任务，未限定任务行的“预览取消”按钮触发 Playwright strict mode。该失败体现多事项任务板下的用户定位问题。
- 已把取消预览/确认操作限定到当前任务行，未放宽断言；最终 `npm run test:e2e` exit 0，2 tests passed（约 11.5s）。随后 `npm run check` exit 0；M5 仍为 partial，外部客户端证据不变。

## 分段验收 Prompt 3：M6 数据保护和恢复（2026-10-10，partial）

### 目标、允许修改与验收场景

- 只处理 M6：本地 Origin、上传大小/真实文件头、存储路径、脱敏 trace、过期 `AgentRun` 恢复、SQLite+附件备份恢复和显式事项删除；对应 E14–E17/E23 的数据保护与恢复部分。
- 实际修改范围：`src/application/data-protection.ts`、`src/application/case-deletion.ts`、`src/app/api/cases/[id]/delete/route.ts`、`tests/integration/m6-data-protection.test.ts`、`docs/m6-runbook.md`、本进度文档。没有删除用户数据库，没有修改 M4 评估资产或模型 Prompt。

### 修改与失败回归

- `redactTrace` 改为字符串安全白名单：未知字段、通知正文、提示词、响应、引用均只保留长度标记；运行 ID、状态、阶段、错误码等稳定控制字段可保留。
- 备份 manifest 升级为 `m6-backup.2`，记录数据库和每个附件的字节数/SHA-256。恢复先校验 manifest、数据库 hash、附件 hash、路径和文件集合，再通过临时目录写入目标；篡改附件或非法 manifest fail-closed，不创建目标数据库。
- 删除现在强制要求当前 `expectedCaseVersion`、明确 `confirmation` 和 `backupAcknowledged`；共享文本/附件仍有其他事项引用时保留，不清理共享文件。
- 临时 SQLite 回归覆盖跨源请求、路径穿越、非法图片/大小、未知字段正文不入 trace、过期运行不提交事项、未停写备份拒绝、附件 hash 篡改、恢复引用一致、缺失版本删除拒绝和共享材料保留。

### 命令、退出码与证据

| 命令 | 实际结果 | 证据 |
| --- | --- | --- |
| `npm run check` | exit 0；TypeScript、ESLint、规格静态检查通过 | 规格静态输出；`docs/m6-runbook.md` |
| `npm run test:integration` | exit 0；8 files / 32 tests passed；独立临时 SQLite，M6 文件 4 tests | `tests/integration/m6-data-protection.test.ts`；`scripts/test-integration.mjs` 自动清理临时目录 |
| `npm run test:unit` | exit 0；5 files / 16 tests passed | Vitest stdout |
| `npm run test:e2e` | exit 0；2 tests passed（约 12.1s）；独立临时 SQLite + 本机 Chrome | `tests/e2e/m2.spec.ts`；`scripts/test-e2e.mjs` 自动清理临时目录 |
| `npm run build` | exit 0；Next 15.5.4 production build 完成 | Next build stdout；仅有 Next ESLint plugin warning，不影响退出码 |

完整说明和恢复步骤见 [M6 本机故障演练与交付记录](m6-runbook.md)。本轮没有公网备份端点、真实外发或用户数据库操作。

### 未完成与状态

- 应用层 M6 回归和完整工程命令通过。
- 没有跨进程写锁、自动定时备份、跨进程停写证据或掉电级恢复演练；`createBackup` 仍要求调用者先停写并传入 `quiesced: true`。宿主、Next.js、provider 日志的脱敏配置也没有部署环境证据。
- 因此 M6 保持 **partial**，不能标记 complete。下一步按序列进入 Prompt 4（M7）；跨进程/掉电与宿主日志属于后续受控环境验收。

## 分段验收 Prompt 4：M7 脱敏试点报告器（2026-10-11，not_run）

### 目标、允许修改与保护边界

- 只处理 M7 报告器、空模板和脱敏输入校验；没有修改 M4 held-out/gold/prompt，也没有录入真实参与者数据。
- 本轮修改文件：`scripts/report-m7.mjs`、`tests/eval/m7-report.test.mjs`、`docs/m7-pilot.md`、本进度文档。参与者 ID 现在只接受 `pNN`/`pNNN` 或 `anon-...` 形式，并额外拒绝 7–15 位纯数字的手机号样式；报告仍不输出参与者 ID。

### 修改与失败回归

- 新增个人信息样式参与者 ID回归：`12345678901` 返回 `M7_INPUT_INVALID`；新增删除一条 A/B/C 会话的缺失配对回归，同样 fail-closed。
- 既有未知字段、空模板和合成完整配对回归保持不变。完整合成输入验证各条件分母、失败分类、C 相对 B 的配对差值和门槛判断控制流；它不计为真实试点证据。

### 命令、退出码与证据

| 命令 | 实际结果 | 证据 |
| --- | --- | --- |
| `npx vitest run tests/eval/m7-report.test.mjs --maxWorkers=1 --minWorkers=1` | exit 0；5 tests passed | `tests/eval/m7-report.test.mjs` |
| `npm run eval:m7 -- --input=evals/m7/pilot.template.json --out=evals/runs/m7-pilot-2026-10-11/summary.json` | exit 1；报告 `status=not_run`，参与者 0，会话 0 | summary.json（本地报告：`evals/runs/m7-pilot-2026-10-11/summary.json`） |
| 非法输入（手机号样式 ID）`npm run eval:m7 ...` | Node 实际 exit 2（PowerShell `$LASTEXITCODE=2`）；`status=invalid`、`code=M7_INPUT_INVALID` | 未写入有效报告；临时输入已删除 |
| 合成完整输入 `npm run eval:m7 -- --input=... --out=evals/runs/m7-pilot-synthetic-2026-10-11/summary.json` | exit 0；8 名合成参与者、48 会话，`status=passed` | summary.json（本地报告：`evals/runs/m7-pilot-synthetic-2026-10-11/summary.json`）；仅控制流演练，不是用户试点 |

### 状态与未完成

- M7 仍为 **not_run**：当前没有真实参与者、同意/退出、失败分类或真实下一轮决策数据，因此没有真实分母、改善百分比或继续决策结论。
- 空模板和非法输入继续 fail-closed；只有未来受控录入 8–12 位真实操作者、每人两个难度匹配的完整 A/B/C 配对、至少三项观察问题、校正时间审查和负责人决策后，才可解释真实报告。
- 按序列下一步进入 Prompt 5，仅复跑完整工程命令并核对 M4/M5/M6/M7 状态，不修改冻结评估资产。

## 分段验收 Prompt 5：冻结后完整工程验收（2026-10-11）

### 冻结检查与失败修复

- 本轮未修改模型 Prompt、gold、held-out 语料、评分器阈值或历史报告；只修复了最终离线运行暴露的模块解析阻断，并补充用户可见失败回归。
- 首次 `npm run eval:offline` exit 1，24/24 fail，根因是 `src/application/task-commands.ts` 对 `../domain/preparation` 使用无扩展 ESM 导入，Node 离线 harness 报 `Cannot find module`，所有场景在执行前失败。
- 先在 `tests/eval/runner.test.mjs` 增加 E01 场景加载回归，再将导入改为显式 `../domain/preparation.ts`，并启用 `allowImportingTsExtensions`。修复后 focused runner 回归 5/5 通过，完整离线评估恢复为 24 pass / 0 fail / 0 not_run。

### 按规定顺序的最终命令证据

| 顺序 | 命令 | 实际结果 | 报告/警告 |
| --- | --- | --- | --- |
| 1 | `npm run check` | exit 0；TypeScript、ESLint、规格静态检查通过 | 静态规格检查未执行应用场景 |
| 2 | `npm run test:unit` | exit 0；5 files / 16 tests passed | 无失败 |
| 3 | `npm run test:integration` | exit 0；8 files / 32 tests passed；独立临时 SQLite | 无失败 |
| 4 | `npm run test:eval` | exit 0；6 files / 38 tests passed；串行执行 | 无失败 |
| 5 | `npm run eval:offline` | exit 0；24 pass / 0 fail / 0 not_run | summary.json（本地报告：`evals/runs/m3-offline-2026-10-11T07-20-19-270Z/summary.json`）；Node 提示 TypeScript ESM 将重新解析为 ES module，只有性能影响 |
| 6 | `npm run test:e2e` | exit 0；2 tests passed（约 20.2s）；独立临时 SQLite + 本机 Chrome | Playwright/WebServer 输出 `NO_COLOR` 与 `FORCE_COLOR` 警告，不影响测试 |
| 7 | `npm run build` | exit 0；Next 15.5.4 production build 完成 | Next ESLint plugin 未检测警告，不影响构建 |
| 8 | `npm run eval:m7 -- --input=evals/m7/pilot.template.json --out=evals/runs/m7-pilot-final-2026-10-11/summary.json` | exit 1；`status=not_run`，参与者 0，会话 0 | summary.json（本地报告：`evals/runs/m7-pilot-final-2026-10-11/summary.json`） |

### 最终验收矩阵

| 里程碑 | 状态 | 依据与未完成证据 |
| --- | --- | --- |
| M4 真实视觉识别与提取 | **partial** | 当前历史记录的冻结模型评估达到点估计门槛，但仍缺真实 provider/部署边界、稳定性和完整审计证据；本轮未修改 M4 资产 |
| M5 本地产品链与日历 | **partial** | 本地 API/UI、集成和 E2E 通过；缺两个实际日历客户端或独立 parser 的版本化导入、重复导入/取消传播证据 |
| M6 数据保护和恢复 | **partial** | 应用层回归和完整工程命令通过；缺跨进程停写、掉电/中断恢复和宿主日志脱敏环境证据 |
| M7 脱敏试点 | **not_run** | 空模板保持 `not_run`；没有真实 8–12 位参与者和真实配对数据，不得写用户改善或继续决策 |

代码和确定性测试链已通过本轮复跑，但外部客户端、部署环境和真实用户证据仍未满足，因此不能把项目标记为 complete。下一步只能按 Prompt 6 生成交付结论，或先补齐相应外部证据。

## D1：本地体验 Demo 整合（2026-10-13）

### 目标、范围和实际改动

- 用户分配：整合已有内容，提供可用本地 Demo。任务范围见 [D1 任务卡](07-work-plan.md)，对应 E01/E04/E06/E08/E09/E14/E16/E20/E21。未扩大到公开部署、外发或真实用户试点。
- 统一“通知簿”界面：通知收件箱、任务板、原文审核、原文证据、变更预览、材料勾选、完成声明、准备步骤、依赖选择、交接记录、取消预览、ICS 与来源历史；增加窄屏布局、忙碌/错误/空态和草稿刷新恢复。
- `src/demo/samples.ts` 与 `/api/demo/candidate` 提供三份明确标识的合成样例（首次报名、延期新增材料、日期未知）。仅演示模式、确切审核稿全文匹配时生成固定 schema 1.0 候选；不调用模型，不自动提交。新建与更新继续走已有 IntakeService 预览/确认流程。
- 任务只读投影补足 requirements/completionRecords/sources，修复界面没有材料准备入口导致无法完成的问题；重复保存同文本复用草稿，人工校正保留旧文稿并清除当前审核与候选。
- 先添加实际失败回归，再修复新增/撤销材料未递增 requirement_epoch、已完成任务未显示 needs_review、更新来源未同事务保存以及首次来源引用使用临时 seg ID 的缺陷。任务 ID、旧 ready 材料、原通知和旧 CompletionRecord 均保留；来源引用现在可解析到真实 Evidence。
- `npm run demo` 固定离线 mock、清空继承的模型密钥，仅监听 127.0.0.1；独立使用 `data/demo/demo.db` 与 `data/demo/uploads`。新库建表，既有库先只读结构比较再复用，结构不一致时停止。未 seed 正式任务、未清空任何应用数据库。
- README 已替换过时的“尚未实现应用/M0开发壳”运行说明。当前目录无 `.git`，因此无法提供 Git diff/commit；所有修改仅发生于 D1 分配的应用、启动、测试和交付文档，未改冻结模型评估资产或密钥文件。

### 实际命令、退出码与证据

| 命令 | 实际结果 | 证据 / 限制 |
| --- | --- | --- |
| `node --check scripts/demo.mjs` | exit 0 | 启动脚本语法检查 |
| `npm run demo -- --prepare-only`（首次与复跑） | 均 exit 0 | 带继承 glm/模拟密钥/旧库 URL 的复跑仍固定 mock/独立目录；原库与已有演示库 hash 不变，cases/tasks/auditEvents 均为 0 |
| `npm run check` | exit 0 | TypeScript + 现有 ESLint + 规格检查；现有 ESLint 未配置有效 TS lint，不能声称 TS lint 覆盖已补齐 |
| `npm run test:unit` | exit 0；5 files / 16 tests | 纯领域及既有候选/适配器单元回归 |
| `npm run test:integration` | exit 0；10 files / 41 tests | 独立临时 SQLite；[Demo API 回归](../tests/integration/demo.test.ts) 5 项、[更新/来源/回滚回归](../tests/integration/demo-update.test.ts) 4 项 |
| `npm run eval:offline` | exit 0；24 pass / 0 fail / 0 not_run | summary.json（本地报告：`evals/runs/m3-offline-2026-10-13T07-26-30-608Z/summary.json`）；既有 ESM 重解析提示，无业务失败 |
| `npm run test:e2e` | 最终 exit 0；3 tests passed（37.8s） | 独立临时 SQLite/上传目录 + 本机 Chrome，显式 mock/DEMO_MODE；首次两个不同的测试定位/异步等待问题已定位修正，未放宽业务断言 |
| `npm run build` | exit 0 | Next 15.5.4 生产构建；既有 Next ESLint plugin 提示 |
| `npm run demo` | 持续运行，Ready | `http://127.0.0.1:3000`；实际 HTTP 200，独立演示库任务数 0，页面已在 Codex 浏览器打开并保留 |

### 浏览器验证和交付边界

- 真实浏览器覆盖：合成 PNG 上传 → 人工校正 → 确切文本审核 → 固定候选 → 预览 → 确认；材料 missing 时完成返回 422，无 CompletionRecord；勾 ready 后记录完成成功。
- 后续通知预览不改正式任务；确认保持原 taskId/caseId，原完成记录逐字段保留，新在读证明 missing，原报名表 ready，显示需复核，两份原文可读。
- 准备时间/依赖界面可操作；交接意向保持旧负责人，用户记录已接受后才切换别名；ICS 未知日期拒绝、日期确定后导出、取消前预览及取消文件传播状态均验证。
- 合成数据截图已人工查看：`test-results/demo-tasks-desktop.png`、`test-results/demo-tasks-mobile.png`（测试产物，复跑会重建）；无横向溢出。另检查实际 Codex 侧栏浏览器首页，模式/空态/样例入口正确。
- D1 当前状态：**done**。M4/M5/M6 继续 **partial**，M7 继续 **not_run**。本轮未运行真实 provider 或 held-out 模型质量评估（未改 provider、Prompt、解析器或冻结语料）；固定候选不能代表任意通知识别效果。未知日期可保存已知材料，但暂不能导出日历；阻塞关系问题需明确选择原任务。
- 原有更多真实识别澄清交互、外部日历客户端行为、宿主环境恢复与真实试点证据仍未完成。自有通知可以保存/校正/审核，当前离线 Demo 只为固定样例生成候选；图片识别不调用 OCR，可手工校正。
- 下一步：用户先体验 D1，记录具体 UX/业务失败并转脱敏回归；重新启动的第一条命令 `npm run demo`。关闭服务后演示数据保留，无公开服务部署。

## D2：真实通知与截图入口（2026-10-13—14，工程通过 / 模型质量 partial）

- 用户分配：把 D1 接通本机已有 GLM 服务端配置；任务卡 D2/D2a/D2b。离线 `npm run demo` 保持 mock；`npm run demo:real` 明确启用真实识别，复用独立 `data/demo/`，不覆盖应用库或密钥文件，不外发消息/表单，不公开部署。
- 界面新增 PNG/JPEG OCR、任意已审核文本提取、真实/固定候选区分与主动外传说明；普通用户不用在网页填写 key。OCR 后须对照原图保存校正并审核，候选须核证据、预览再确认。
- 先取得用户失败回归，再修复私有附件根目录、多材料漏项、重复图片、已提交草稿重复识别、OCR/提取等待期间旧稿覆盖、旧标签页人工校正和同稿候选替换竞争。保留不可变 TextRevision、旧完成证据、稳定 taskId、CAS、幂等和事务。最后审查发现的通用提案确认旁路正在修复验收。
- D2a 生产视觉/视觉修复 Prompt 与候选输出契约分离，版本 `m4.5-vision.1`；候选主/修复 Prompt 的 m4.3 原字节保持。新增失败回归后 Prompt 单元 5/5、Runner 集成 6/6 通过。生产 Prompt 的 held-out 入口复用实际 builders/候选与证据校验，明确 `eval_budget`，不冒充完整 ModelRunner 流程或历史英文协议。
- D2b 正在添加有界响应的 thinking 配置；不改 key、模型名、schema、gold、评分、历史报告或 60 秒请求/240 秒 run/3 次调用/1 次网络重试预算。配置与质量验收完成前不能标 done。

### 已取得的实测证据

| 命令/路径 | 实际结果 | 证据与解释 |
| --- | --- | --- |
| D2 基础 `node --test scripts/demo.test.mjs` | exit 0；6 tests | 两种模式、服务端环境与密钥不输出 |
| D2 基础 check / unit / integration | 均 exit 0；unit 16、integration 68 tests | 临时 SQLite；为新增并发修复前的基线，不能代替最终复跑 |
| D2 基础 `npm run eval:offline` | exit 0；24 pass / 0 fail | summary（本地报告：`evals/runs/m3-offline-2026-10-13T08-20-37-295Z/summary.json`） |
| D2 基础 `npm run test:e2e` / build | exit 0；3 pass / 1 intentional skip；build exit 0 | 默认 E2E 不执行 real 文件；既有 Next lint plugin 提示 |
| `npm run test:e2e:real`（最新并发修复后） | exit 0；1 pass（17.5s）、5 HTTP calls | 独立临时应用/SQLite/附件 + 本机 HTTP 合成 provider；文字和图片确认链、重复请求、失败草稿恢复，不能作为线上识别质量成绩 |
| 初次真实文本调用 | failed；504 MODEL_TIMEOUT，2 calls / 1 retry，约120s | summary（本地报告：`evals/runs/d2-online-smoke-2026-10-13T08-26-21-728Z/summary.json`），正式任务 0→0 |
| 初次真实 OCR | failed；422 MODEL_INVALID_OUTPUT，2 calls，约76s | summary（本地报告：`evals/runs/d2-online-image-2026-10-13T08-30-40-471Z/summary.json`），草稿保留 |
| 新进程真实入口复查 | failed；文本503、OCR504 | summary（本地报告：`evals/runs/d2-online-app-2026-10-13T12-06-41-081Z/summary.json`），正式任务 0→0 |
| D2a C01 生产 Prompt 开发集 1轮初版→更新 | exit 1；初版fail、更新not_run | summary（本地报告：`evals/runs/m4-model-2026-10-13T12-17-06-780Z-application/summary.json`）；实际 OCR HTTP200/6.384s 成功，文本超时后网络失败；未用黄金答案替换失败结果 |
| thinking disabled 合成诊断 | 非质量评估；视觉通过、文本结构失败 | summary（本地报告：`evals/runs/d2-thinking-diagnostic-2/summary.json`）；同模型、文本200约18.6s（含一次repair）、视觉200约2.3s，原 due schema 继续拒绝不合规输出 |

### D2b 与最终复核的新证据

- thinking 参数基线先实际失败：7 项 Vitest / 3 项启动回归；修复后 focused 49/49、启动 8/8、check 通过。普通应用未配置时不增加请求字段，真实 Demo 默认双 disabled 并尊重显式 enabled，离线固定 mock/空 key，OCR repair 使用文本参数；保留原预算。应用评估 catalog 同步生产 evidenceCatalog，默认英文路径未变。
- 最新全量 unit 26/26、test:eval 45/45、build exit0；离线回归（本地报告：`evals/runs/m3-offline-2026-10-13T12-42-16-042Z/summary.json`） 24 pass / 0 fail / 0 not_run。build 此次先于 D2c 后续提示修复，最终需要复核。
- 最新 真实 API smoke（本地报告：`evals/runs/d2-final-smoke-2026-10-13T12-35-08-492Z/summary.json`） exit1：OCR200/2.03s，文本及图后候选均422 MODEL_INVALID_OUTPUT，正式任务0→0。不把参数接通当作可用成绩。
- D2b 生产 Prompt held-out（本地报告：`evals/runs/m4-model-2026-10-13T12-34-19-339Z-application/summary.json`） 为 **incomplete**：按 D2c 修复决定停止，已结束20/60（0 pass、10 fail、10 dependent not_run），其余40保留 PENDING/not_run；未删原报告、未改 gold 或拼接不同配置成绩。失败有 due 结构、英文原文被翻译、类别/关系/证据及少量超时。
- 提案旁路先取得6项实际失败，再修：新通知提案持久化内部标记，缺来源拒绝；空操作无来源拒绝；旧非空证据须真实存在、属于 Case 且 span/原文一致。focused19/19及tsc通过，合法取消/补偿/重放保持。未迁移库。很早期无标记且非空无证据的通用提案无法从 payload hash 与通知派生提案区分；当前通知派生路径每个操作都有字段证据及内部标记，这一历史限制不宣称已迁移解决。

以上为 D2b 阶段证据；后续实际结果见下面的收尾记录。线上仅发送合成材料，报告不含密钥或模型推理正文。

### D2c / D2d 与收尾记录（2026-10-14）

- 生产请求版本为 `m4.6-demo.1`：补全现有 due 分支、原文语言、类别与超限阻塞约束，修复请求保留确切文稿/证据目录/所选目标。原 m4.3 基础 builders 字节保留，不改 schema、gold、评分、历史报告或预算。先取得请求契约回归失败，再修复；相关回归通过。
- D2c 完整生产 Prompt held-out（本地报告：`evals/runs/m4-model-2026-10-13T12-49-52-154Z-application/summary.json`） 实际 **exit1 / failed**：60 个计划版本，2 pass、32 fail、26 因前版失败 not_run，无 PENDING；34 个实际执行版本共68次调用全HTTP200，无结构修复/网络重试，最长请求24.114秒。关键事实75/300、证据124/300，三轮均正确0/10。模型质量未通过；只读评估的自动提交检查仍 not_run，不能用它证明应用写库安全。
- D2c 真实 API smoke（本地报告：`evals/runs/d2-final-smoke-2026-10-13T12-48-49-558Z/summary.json`） 实际 exit1：文本与图后提取均收到可解析候选，但预览分别以 CLARIFICATION_REQUIRED / CANDIDATE_CATEGORY_REQUIRED 拒绝。模型遗漏类别及精确时刻，OCR 还可能翻译原文；正式任务0→0。
- D2d 显式临时 `glm-4.7-flash` 实际 API smoke（本地报告：`evals/runs/d2-final-smoke-2026-10-13T13-04-05-604Z/summary.json`） exit1：OCR200，两次提取503 MODEL_UNAVAILABLE，正式任务0→0。一次生产请求诊断（本地报告：`evals/runs/d2-exact-production-flash-diagnostic-2026-10-13T17-05-25-188Z/summary.json`） HTTP429/供应商1305、195ms，1call/0retry；不将供应商错误记作结构评分失败。没有继续无界重试或切换付费型号；未保留此模型覆盖、未改用户 `.env.local`，因此不启动其完整 held-out 或引用旧型号成绩。
- 实际浏览器确认：不完整候选预览被拒绝，没有正式任务写入；发现 boundary unspecified/缺失误显示“含当日”。先取得2项失败，再抽取共用 dueLabel，候选/预览/任务统一显示“截止边界待确认”，9项显示回归通过。真实入口改为试用文案，README 明确未通过质量评估、可能漏项与尚无完整候选校正/澄清界面。
- 收尾审查另发现旧 candidate/confirm 接口可绕过预览与字段证据。先取得4项实际失败，再停用任意旧 candidate action，非 schema 1.0 确认返回422 LEGACY_CANDIDATE_UNSUPPORTED，移除旧直接写库与不可达重复分支；正常候选仍经 IntakeService 预览、来源证据、事务与幂等确认。人工校正测试改用真实严格样例候选并先断言候选存在，避免空通过；focused56/56及tsc通过。既有用户任务、原文和库结构保留。

| 最终相关命令 | 实际结果 | 证据 / 局限 |
| --- | --- | --- |
| `npm run check` | exit0 | TypeScript / 现有 lint / 规格链接通过；未新增 TS lint 覆盖 |
| `npm run test:unit` | exit0；8 files / 39 tests | 含 Prompt、配置、GLM 参数与日期显示回归 |
| `node --test scripts/demo.test.mjs` | exit0；8 tests | 模式隔离、服务端参数及无密钥输出 |
| `npm run test:integration` | exit0；12 files / 88 tests | 独立临时 SQLite；旧候选拒绝、合法确认与来源、幂等、CAS、回滚、完成复核 |
| `npm run test:eval` | exit0；7 files / 46 tests | 最新 m4.6 请求上下文和应用评估入口；未用离线测试冒充模型成绩 |
| `npm run eval:offline` | exit0；24 pass / 0 fail / 0 not_run | summary（本地报告：`evals/runs/m3-offline-2026-10-13T17-11-37-316Z/summary.json`）；已有 Node ESM 重解析提示 |
| `npm run test:e2e` | exit0；3 pass / 1 intentional skip；16.6s | 本机 Chrome、独立临时库；上传校正、完成复核、交接、预览确认、ICS |
| `npm run test:e2e:real` | exit0；1 pass；11.8s，5 HTTP calls | 独立临时应用/SQLite/附件、本机合成 HTTP provider；文字、图片与失败草稿路径，不能作为线上质量证据 |
| `npm run build` | exit0 | Next15.5.4；已有 Next lint plugin 提示，未公开部署 |
| `npm run demo:real` | 持续运行，Ready | `http://127.0.0.1:3000/`；原服务端配置、双 thinking disabled、独立 `data/demo/` 复用；无临时4.7覆盖 |

- 最终实际浏览器检查：右上角真实模式、试用及主动外传说明正确；合成历史候选显示“截止边界待确认”，预览拒绝并显示普通用户提示，正式任务数保持0。已把页面恢复到新通知首页供体验，原草稿仍在本机库；浏览器标签保留。截图仅合成材料或空首页：`test-results/demo-real-blocked.jpg`、`test-results/demo-real-home.jpg`。

当前 D2 **partial**；工程接入及安全修复完成，模型质量验收未通过。M4/M5/M6 仍 partial，M7 not_run。可交付真实 OCR/提取试用入口及合成流程体验，不能宣称任意通知可稳定自动整理。普通用户准备及操作见 README；本机 key 已配置，网页无需填写。下一步若继续提升真实识别，应另分配候选校正/澄清体验与新的模型质量验收任务；重新启动第一条命令为 `npm run demo:real`，离线体验为 `npm run demo`。

## D3：普通用户指南与 GitHub 发布（2026-10-14）

- 用户分配：介绍 Demo 解决的痛点、背景/场景和普通用户操作，整合为 README 并上传 GitHub；用户选择新建私有仓库 `campus-notice-agent`。范围见 [D3 任务卡](07-work-plan.md)，本轮仅修改 README、任务卡和进度，不改应用、模型、数据库或冻结评估资产。
- README 围绕报名已完成后收到补交材料通知的场景，解释通知来源、材料准备、用户完成声明、原任务更新与需复核；补齐固定样例、自己的文本/截图、启动条件、服务端 Key、主动外传、失败草稿、交接和 ICS 的实际语义。明确真实识别质量未通过及澄清/候选字段编辑缺失，没有写成已稳定可用。
- 只读交叉审查按实际页面与代码核对按钮和先后顺序；修正更新通知必须确认文本、新增材料先标备齐再记录补充完成，以及新仓库仅含指南、启动需完整源码的说明。
- 当前本地仍无 `.git`，没有初始化本地仓库或批量推送。通过已认证的 GitHub 账户创建 [私有仓库](https://github.com/Dylan7DAI/campus-notice-agent)，仅上传 [README](https://github.com/Dylan7DAI/campus-notice-agent/blob/main/README.md)。未上传源码、密钥、用户数据库、原图或个人通知。

| 本轮命令 / 操作 | 实际结果 | 证据 / 限制 |
| --- | --- | --- |
| `node evals/runs/d3-readme-check.mjs` | exit0 | 指南关键章节、合成日期、更新顺序、质量限制、代码围栏与敏感数据检查；忽略目录内的本地校验辅助文件，未上传 |
| `node scripts/check-spec.mjs` | exit0 | 规格结构和文档引用检查；不作为应用或模型质量测试 |
| `gh repo create Dylan7DAI/campus-notice-agent --private` | exit0 | 创建用户指定私有仓库；实际命令同时设置中文介绍 |
| GitHub contents API 新建 `README.md` | success | commit `e7cd2c502a660c9947be8e5aa3083e14cfecc5e0`；取回 UTF-8 文本与最终本地 README 逐字相同，blob `ff3205218bb834513672484830d4d59e25fa9e2c` |
| `gh api` 仓库与 `git/trees/main` 复核 | 均 exit0 | `private=true`，默认分支 `main`；完整树仅 `README.md`，`truncated=false` |

- D3 状态：**done**。本轮为文档发布，未重跑应用/模型测试；README 的工程与质量结论引用 D2 已记录的实际结果。D2/M4/M5/M6 保持 partial，M7 保持 not_run。
- 局限与下一步：GitHub 当前仅有介绍与指南，不能从该仓库直接安装运行；后续如需发布完整可运行项目，应另按用户分配检查源码、许可、依赖和排除项后上传。现有本地 Demo 及其数据保留。

## D4：可运行 Demo 的 GitHub 发布（2026-10-14）

- 用户分配：将 Demo 源码上传至现有私有仓库，使用方法与 README 一致；范围见 [D4 任务卡](07-work-plan.md)。沿用远程 D3 README 提交建立本地 Git，没有替换远程历史、修改模型契约或移动/清空用户数据。
- 发布范围：应用源码、启动/验证脚本、Prisma schema、精确 lockfile、配置示例、测试、规格与合成评估资产。排除密钥、用户通知/原图、所有层级 SQLite、依赖、构建缓存、日志及 `evals/runs/`；新增 `*.tsbuildinfo` 忽略。暂存检查初次186个文件、约1.9 MB，配置密钥逐字检查与凭据模式检查均通过；60张PNG及manifest与冻结合成生成器逐字节一致。
- README 现提供私有仓库下载 ZIP / Git 克隆、在项目文件夹直接 `npm ci` → `npm run demo` 的步骤；真实模式仍需使用者自己的服务端 Key。历史报告不随源码上传，因此53个报告链接改为明确的本地路径文字，保留成绩和失败记录，避免干净目录规格检查因报告缺失失败。
- 初次独立目录 `npm ci` exit0；随后 `npm run check` 实际exit1，Prisma Client 占位类型导致隐式any错误。显式 `npm run db:generate` exit0 后，相同 check exit0，确认根因；修复为 check/build 先生成 Client，不放宽 TypeScript、不改领域/数据库结构。原启动命令自行生成Client并建立空演示库，实际端口3014 Ready、首页HTTP200；此为升级前启动诊断，后续新版验收另记录。
- 安装告警核查后，将 Next15.5.4/React19.1.1 同分支更新并精确锁定为 Next15.5.27/React及ReactDOM19.1.9，lockfile 同步；不自动执行跨主版本 audit fix。依据：[Next补丁发布](https://github.com/vercel/next.js/releases/tag/v15.5.27)、[Windows RCE公告](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36)、[React补丁发布](https://github.com/react/react/releases/tag/v19.1.9)。CI 保留安装/check/build，明确关闭框架遥测和更新检查；不公开部署或联网模型测试。

### D4 独立目录验收结果

从暂存发布内容导出两个独立目录，不带dotenv、用户库、依赖或缓存；最终目录按README实际安装、启动。修改仅为发布说明、生成检查与同分支框架补丁，领域、schema、Prompt和gold不变。

| 实际命令 / 路径 | 结果 | 证据 / 限制 |
| --- | --- | --- |
| 新版 `npm ci`（两个独立目录） | 均exit0；约7分钟/8分钟 | npm registry与Prisma引擎下载较慢，进程/连接与引擎文件增长确认有进展；锁定Next15.5.27、React19.1.9、Prisma6.16.2 |
| 最终全新目录 `npm run check` | exit0 | 首次check显式生成Client，TypeScript、现有lint、规格引用通过；仍未新增TS lint覆盖 |
| `node --test scripts/demo.test.mjs` | exit0；8/8 | 离线/真实模式与服务端参数隔离 |
| `npm run test:unit` | exit0；39/39，8 files | Prompt、候选、配置、领域和日期显示 |
| `npm run test:integration` | exit0；88/88，12 files | 独立临时库；来源、事务、幂等、CAS、完成复核和数据保护 |
| `npm run test:eval` | exit0；46/46，7 files | 应用提示契约与评估控制流，不代表线上模型质量 |
| `npm run eval:offline` | exit0；24 pass / 0 fail / 0 not_run | 验收目录本地报告 `evals/runs/m3-offline-2026-10-14T02-24-30-895Z/summary.json`，不上传 |
| 新版 `npm run demo -- --port=3014` | Ready；HTTP200，初始task数0 | 自动建立独立空演示库，主页含通知簿；验收服务随后停止，原项目3000服务未操作 |
| `npm run test:e2e -- --config publish.playwright.config.ts` | exit0；3 pass / 1 intentional skip，34.6s | 仅验收目录临时配置改端口3015，临时库+本机Chrome；上传校正、创建、完成、更新需复核、交接和ICS。首次临时配置位于自动清理的outputDir导致spawn ENOENT，确认配置已被清理后移至验收目录根；未修改应用或放宽断言 |
| `npm run test:e2e:real` | exit0；1 pass，20.9s，5 HTTP calls | 独立临时应用/SQLite/附件、本机合成HTTP provider与端口3001；OCR/文本、审核、预览确认、重放和失败草稿，不调用线上模型 |
| `npm run build` | exit0 | Next15.5.27生产构建与类型检查；现有Next ESLint plugin提示 |
| 安装及 `npm audit` 摘要 | 13项告警仍存在 | 2 critical（测试工具）、9 high、2 moderate（含传递依赖）；不宣称所有依赖安全，不用跨主版本升级或强制audit fix掩盖 |

- 人工查看本轮合成桌面与窄屏截图：更新后报名表ready、在读证明missing、需复核及旧完成声明/历史可见，窄屏无横向溢出。图片仅在验收目录 `test-results/`，未上传。
- 本地发布验收通过，准备推送源码；远程提交与私有树复核随后记录。D2/M4/M5/M6继续partial，M7 not_run；没有重跑线上质量评估或真实试点。
