# 架构与实现边界

状态：以下目录、数据库和模块是待实现目标，不是已有代码。

## 建议技术基线

采用 TypeScript 单语言的模块化单体：Node.js 22 LTS + Next.js App Router（Node runtime）+ React + Prisma/SQLite + Zod；测试使用 Vitest 和 Playwright。M0 从官方文档核实兼容版本，锁定完整 package-lock.json 和 engines，不依赖未经核对的 latest。测试以临时 SQLite 文件模拟生产事务，不用内存 Map 代替持久化集成测试。

选择理由：个人可本地启动，UI 和服务共享类型，弱 coding Agent 少跨语言迁移，SQLite 便于快照与复现。此阶段不依赖 LangGraph、Temporal 或向量数据库。未来只有流程要跨进程长期运行或多账号协作时再评估替换；普通关系表 + 事务审计足够表达 MVP，不需要完整事件溯源平台。

图像输入默认使用可替换的视觉识别 provider 得到带文本的草稿，再审核和结构化提取；无可用模型时可粘贴/校正文本，仍能跑完整领域流程。Mock 为开发和回归服务，真实截图能力必须在 M4 另行通过真实图片评估。

## 目标目录与依赖方向

```text
src/
  app/                    # 页面、route handlers，仅协调和展示
  domain/                 # 纯函数：差异、状态、完成覆盖、准备影响、时间
  application/            # 命令、校验、工作流、ports
  infrastructure/
    db/                   # Prisma repositories、事务
    models/               # mock / 实际视觉与提取 adapters
    storage/              # 私有附件读写
    calendar/             # ICS 编码
    telemetry/            # 脱敏日志
  contracts/              # 从已审阅 schema 映射的运行时验证器
  components/             # 只通过应用接口读取/操作
prisma/                   # schema、migration、合成 seed
tests/{unit,integration,e2e}/
evals/                    # 场景、离线 runner、独立模型评估
docs/                     # 设计依据和进度
```

依赖：UI/routes → application → domain；infrastructure 实现 application 定义的 ports，在服务启动处装配。domain 不知道 Prisma/Next/模型供应商；application 不依赖 React。通过 ESLint no-restricted-imports 或架构测试强制边界，不只写在 Markdown 中。共享契约不能 import server secrets。

## 端到端运行状态

```text
received → recognizing → text_review → extracting → needs_clarification
                                            ↘ proposal_ready → applied
任一外部调用 → failed_retryable / failed_terminal / cancelled
```

状态持久化到 Intake/AgentRun。进程重启把 running 超出租约的识别/提取标 interrupted，用户可重试；重试复用已经确认的 text_revision 和已保存步骤，不重复执行 commit。禁止未经确认自动恢复应用更新。执行权只属于应用层；模型没有 DB、终端或网络抓取工具。

ports（只说明职责，准确输入由契约和任务实现）：

- `Recognizer.recognize(artifact, abortSignal)` → TextDraft。可替换视觉/OCR，人工校正另存版本。
- `Extractor.extract(textRevision, context, abortSignal)` → NoticeCandidate，经严格 schema 和证据校验。
- `CaseRepository.transaction(command)` → CommitResult，内部版本检查、幂等及审计。
- `Clock.now()` / `IdGenerator.next()` → 可注入测试，避免系统时钟和随机 ID 污染回归。
- `PrivateStorage.put/read/delete()` → 只接受服务生成的 object key，不接受用户任意文件路径。
- `CalendarExporter.generate(taskProjection)` → bytes + uid/sequence，下载前检查最新投影。

## 存储与事务

关系表参见领域实体，加 Intake、AgentRun、Owner、ClarificationAnswer。用外键连接 NoticeRevision → TextRevision → SourceArtifact；Task → Case；Requirement/Preparation/CompletionRecord → Task。业务删除采用显式服务操作，默认不使用级联删除掩盖数据影响。

必要约束：Case.version 非负递增；CommandResult(scope,key) unique；artifact sha256 唯一复用；Task/Requirement ID 永不复用；Notice supersedes 关系不得有环或跨 Case；Preparation dependency 不得有环或跨 Case。MVP 禁止跨事项共享准备步骤，从而避免一个事项取消误取消其他任务。

SQLite 启用 foreign_keys、busy_timeout，测试确认 WAL/事务行为与 Prisma 兼容。建表、迁移、唯一约束的失败必须暴露，不用捕获异常后返回 success。不要在事务内等待模型或执行文件大 I/O；附件先保存草稿，数据库引用提交后才成为正式证据，孤儿草稿按清理策略回收。

## 模型上下文边界

只输入当前审核过的 TextRevision、需要关联的至多 5 个候选事项摘要、必要当前要求、固定时间/时区、schema 和提取规则。候选来自本地筛选或用户选择，不能把整个用户库发给模型。超出长度时要求拆分/选区，不截断后悄悄提交。

模型提取事实和推荐关系；用户确定事项关系与关键未知值；确定性代码生成 ChangeProposal 并计算影响。中文语义比对不可靠时让用户确认“新增还是同一材料”，不把 embedding 相似度当更新授权。

## 配置与部署

环境变量名和默认值见 [配置示例](../.env.example)。密钥仅在服务端读，不能有 NEXT_PUBLIC_MODEL_API_KEY。默认 mock，应用须显眼标注“演示识别”；用户主动配置真实 provider 后才允许上传外部模型。`.env.example` 只是配置设计，M0/M4 必须实现实际读取与启动校验。

MVP localhost 单用户，写 API 检查 Origin/Host，拒绝跨源请求；上传做大小、MIME 和实际格式校验，不渲染主动脚本；文件不放 public/。私有原图读取使用受校验的 ID；模型返回的 URL 不自动抓取；通知中的报名链接仅展示，点击前显示域名。公开服务所需登录、账号隔离、速率限制和密钥轮换属于独立后续阶段。

备份使用 SQLite 一致性备份方式（或停服务后一起备份 DB 与附件），不要在 WAL 正写入时只复制一个 .db。迁移前备份；不可逆迁移不得静默运行。测试恢复后核对 source 引用和任务数量。所有数据路径必须留在配置的数据目录内，用户输入不能变成删除路径。
