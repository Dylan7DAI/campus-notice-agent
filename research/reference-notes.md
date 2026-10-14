# 前人工作与工程参考核查笔记

读取日期：2026-09-24。用途：支持校园通知执行 Agent 的设计决策与开发约束。

本笔记核查公开源码和官方标准/文档，未运行 Donetick、未验证其发布包中的实际体验，也未完成系统性学术检索。因此，“已发现源码支持”“官方文档宣称”“本次未发现”必须分开表述，不能将竞品比较直接写成学术创新证明。

## 1. Donetick：基线能力已经比较完整

### 核查范围与固定版本

- 后端仓库：[donetick/donetick](https://github.com/donetick/donetick)，本次取得的 `main` 提交为 `0fb2a3cd017a6efb6a779f262dfef68357d4d011`。
- 前端仓库：[donetick/frontend](https://github.com/donetick/frontend)，本次取得的 `main` 提交为 `944d1b34470971f5987c1a6dd9a28bc586147971`。
- 读取了后端 README、前后端 LICENSE.md、后端调度实现及分工回归测试、前端自然语言输入解析及照片转任务实现。未审计仓库全部内容；提交快照不等于稳定发行版。

| 用户描述/相关能力 | 实际证据 | 可确认的结论及边界 |
| --- | --- | --- |
| 自然语言任务创建 | README 的 Natural Language Task Creation；前端 `AddTaskModal.jsx` 导入 `chrono-node`，调用 `parseAssignees`、`parseRepeatV2`、`parseDueDate`；`CustomParsers.js` 有英语周期、月份、星期与优先级规则 | README 明确描述 plain English。实现证据支持英语自然语言日期/周期和分工提取；不能据此声称中文通知、多通知语义关系或所有复杂日期都能可靠解析 |
| 共享与分工 | README 的 Collaborative、Assignee Rotation；`assignee_test.go` 覆盖 least_completed、least_assigned、random、round_robin、no_assignee 等策略 | 有组内任务分工与轮换。测试还验证非候选人不能被误选、仅一名候选人不能因轮换而丢失负责人。这不等于“被指派者确认接手”或“交接过程闭环” |
| 自适应排期 | `scheduler.go` 的 `scheduleAdaptiveNextDueDate`，固定版本第 350–395 行 | 以连续历史完成间隔做指数衰减加权平均，`decayFactor = 0.5`，再加到本次完成时间。属于具体的历史间隔预测机制，不宜泛称理解通知变化的通用 AI 排程 |
| 照片/截图生成任务 | 前端 `ScanToTask/useScanToTask.js` | 已实现照片/上传文件输入、Tesseract OCR、调用 `localAIService.plainChat`、解析任务 JSON；提示词示例包含 School Form、Appointment、Invitation。浏览器 OCR 初始化使用 `eng`，提示词要求最多生成一项任务。源码存在不代表本次验证了可用设备、模型配置或识别准确率 |
| 照片附件、子任务、通知、REST API | README 的 Add Photos、Subtasks with Smart Reset、Notifications & Integrations、Developer & API Features | 可作为成熟任务管理的功能参考；本次没有逐项运行验证 |
| 通知版本关系、字段级证据、交接确认 | 上述限定读取范围 | 本次未发现能直接证明这些目标机制已经实现的证据；不能据此断言整个产品绝对没有，亦不能推出本项目具有学术首创性 |

### 直接来源

1. [后端 README](https://github.com/donetick/donetick/blob/0fb2a3cd017a6efb6a779f262dfef68357d4d011/README.md)：产品宣称与功能边界。
2. [调度实现 scheduler.go](https://github.com/donetick/donetick/blob/0fb2a3cd017a6efb6a779f262dfef68357d4d011/internal/chore/scheduler.go#L350)：自适应算法实际依据是完成时间间隔。
3. [分工回归测试 assignee_test.go](https://github.com/donetick/donetick/blob/0fb2a3cd017a6efb6a779f262dfef68357d4d011/internal/chore/assignee_test.go)：候选人集合、轮换与空分工等边界条件。
4. [自然语言解析 CustomParsers.js](https://github.com/donetick/frontend/blob/944d1b34470971f5987c1a6dd9a28bc586147971/src/views/components/CustomParsers.js)及[输入集成 AddTaskModal.jsx](https://github.com/donetick/frontend/blob/944d1b34470971f5987c1a6dd9a28bc586147971/src/views/components/AddTaskModal.jsx)：规则与日期解析器如何落到表单字段。
5. [照片转任务 useScanToTask.js](https://github.com/donetick/frontend/blob/944d1b34470971f5987c1a6dd9a28bc586147971/src/views/components/ScanToTask/useScanToTask.js)：OCR → 模型 → 单任务建议。
6. [后端 LICENSE.md](https://github.com/donetick/donetick/blob/0fb2a3cd017a6efb6a779f262dfef68357d4d011/LICENSE.md)与[前端 LICENSE.md](https://github.com/donetick/frontend/blob/944d1b34470971f5987c1a6dd9a28bc586147971/LICENSE.md)：均为 GNU AGPL Version 3 文本。

### 应当借鉴什么

- 使用可编辑的结构化字段承接语言解析结果，让用户能修正错误；不要把模型回复直接视作已提交的任务。
- 区分负责人候选集合与当前负责人；把候选人离开、无负责人、唯一负责人等情况写进回归集。
- 将通知执行的硬截止时间与个人准备安排分开。历史完成习惯可以辅助建议准备时间，不能覆盖来源通知给出的截止日期。
- MVP 先提供可靠的任务板、材料清单和明确状态；无需同时复制积分、物联网、复杂轮换、所有周期规则。
- 截图转任务、自然语言输入、共享分工不应作为核心新颖性主张。更可检验的目标是：在变更通知到来后，维持同一任务的身份、来源、约束、材料与交接状态的一致性。

### 许可证限制与实现方式

Donetick 前后端的 AGPLv3 不是“随意复制到闭源产品”的许可。复制或改编其代码、分发修改版本时，需遵守相应版权声明、许可与对应源码等义务；第 13 条规定，对修改后的程序提供远程网络交互时，须向交互用户显著提供免费获取该版本 Corresponding Source 的机会。

本项目的默认方式是阅读功能与机制、记录来源、独立实现，不拷贝 Donetick 源码或资源，也不把本笔记当作已完成第三方许可审计。若后续决定 fork 或复制代码，先记录精确文件、提交、许可和修改，再明确项目的许可与源码提供方案。不能简单写成“只要通过 API 就必然没有 AGPL 义务”；组合方式的法律边界仍取决于实际实现。

## 2. W3C PROV-DM：证据与版本关系的概念基础

来源：[PROV-DM: The PROV Data Model](https://www.w3.org/TR/prov-dm/)，W3C Recommendation，2013-04-30。本次读取概念、派生/修订、归属、活动关联及委托部分。

可借鉴的三个基本概念为 `Entity`、`Activity`、`Agent`，以及派生 `wasDerivedFrom`、生成 `wasGeneratedBy`、使用 `used`、归属 `wasAttributedTo`、活动关联 `wasAssociatedWith`。PROV 将 revision 视作 derivation 的一种。这里的 Agent 是承担责任的人、组织或软件等实体，不专指大语言模型 Agent。

| 项目对象 | PROV 概念借鉴 | 建议落地 |
| --- | --- | --- |
| 原始截图、通知版本、OCR 文本、任务修订 | Entity | 各版本拥有稳定 ID；保存原始哈希、创建时间和来源位置 |
| OCR、抽取、人工校正、应用变更 | Activity | 保存输入 ID、输出 ID、执行者、时间、模型/提示词版本及操作结果 |
| 通知发布者、确认者、当前负责人、软件 | Agent | 不混同发布者、上传者、确认者和任务负责人 |
| 新通知修订旧通知 | Revision / derivation | 建立显式版本关系，并保留依据；上传顺序本身不足以证明替代关系 |
| 任务字段从某条通知得出 | Derivation / usage | 字段引用不可变通知版本与证据片段；需要时保留提取活动 ID |

边界：PROV 提供表达来源的模型，不负责判断哪条通知权威、两条通知是不是同一事项、抽取是否真实、变更应该如何应用。原文特别说明派生关系存在的条件由未指定的方法确定。因此“有来源链”不能被当作“模型判断正确”的证明。

MVP 使用关系表、外键与 JSON 字段即可，不必一开始引入 RDF 或图数据库。本项目只能称为“借鉴 PROV 的来源建模”，除非后续确实实现和验证标准映射，否则不能声称 PROV 完整兼容。

## 3. LangGraph：持久化、暂停澄清与恢复的工程参考

来源：官方 [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)、[Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers)、[Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)。本次读取持久化作用域、线程 ID、检查点及 interrupt 规则。读取时旧路径 `/durable-execution.md` 返回 Persistence 页面，因此记录实际内容对应的稳定主题链接，不把旧页面标题当作已核实来源。

已核实要点：

- Checkpointer 保存一次任务流的图状态；Store 保存应用定义的跨任务信息。两者用途不同。
- `thread_id` 用于恢复对应检查点；更换 ID 会进入另一条执行历史。
- `InMemorySaver` 重启后丢失状态；需要恢复能力的运行必须使用持久化存储。
- `interrupt()` 可以暂停执行等待外部输入；恢复时从所在节点开头重新执行，之前运行过的代码会再次运行。
- 官方文档要求注意副作用的幂等性，建议将副作用放在 interrupt 后或拆到独立节点；不要广泛捕获其暂停异常，也不要让同一节点中 interrupt 的相对次序随意变化。

对本项目的落地建议：

1. 流程明确为“接收 → 抽取建议 → 关联候选 → 澄清/审阅 → 校验 → 原子应用 → 导出/展示”，阶段之间保存状态。
2. 澄清请求保存其关联通知版本、目标任务版本及选项；恢复前重新校验任务版本。用户回答旧问题不能覆盖期间已发生的新变更。
3. 应用变更必须带稳定幂等键和预期任务版本；重复恢复不得创建第二份材料、重复修订或重复日历事件。
4. 应用事实、审计事件与待执行副作用应在明确事务边界内保存；检查点本身不能替代业务事务、唯一约束和访问控制。
5. MVP 可先使用数据库状态机与显式 job 表实现这些语义。引用 LangGraph 原理不等于必须引入该框架；确有复杂暂停/恢复需求时再按架构决策接入。

边界：框架提供恢复机制，不自动保证业务正确、消息恰好执行一次、通知同一性或证据可信。尤其不能把“模型重新跑一次”当作安全回放。

## 4. RFC 5545：日历导出的互操作约束

来源：[RFC 5545 — Internet Calendaring and Scheduling Core Object Specification (iCalendar)](https://www.rfc-editor.org/rfc/rfc5545)，2009-09。本次读取第 3.1 节内容行、第 3.6.1/3.6.2 节事件/待办、第 3.8.1.11 节状态、第 3.8.4.7 节 UID、第 3.8.7.4 节 SEQUENCE 等相关字段。

已核实要点与项目约束：

- `UID` 是持久、全局唯一的日历组件标识。相同任务的同一种导出组件重导出时保留 UID，不因标题、截止时间或通知版本改变而换新 UID。
- `SEQUENCE` 表达日历组件修订序号。发生有效日历内容变更时递增；重复下载同一修订不制造新的修订号。
- `VTODO` 表达待办，可以带 `DUE`、`STATUS`、`COMPLETED` 等字段；`VEVENT` 表达有时间安排的事件。任务截止和实际活动应明确映射，不因日历可显示而把二者混为一谈。
- 日期、日期时间和时区必须区分；只有日期的截止要求不要未经确认就冒充确定的 23:59 精确时间。`DTEND` 对事件表示非包含式结束，全天事件尤其要注意跨日计算。
- 内容行使用 CRLF；长行按 75 octets 的建议折行；中文 UTF-8 必须按字节安全折行，不能截断字符；TEXT 转义需符合规范。优先使用成熟 iCalendar 库并加针对性互操作测试。
- 取消应反映到所导出组件的状态与修订，同时在界面上明确这是已取消事项。

能力边界：`.ics` 下载是快照导出。标准中的稳定 UID 与 SEQUENCE 不保证任意客户端再次导入时都覆盖旧条目，某些导入流程可能产生重复。MVP 文案必须说“导出日历文件”，不能说“已同步/将自动更新你的日历”。若后续增加订阅源、CalDAV 或日程邀请协议，需要另立同步契约并验证目标客户端；不能仅依靠 RFC 5545 宣称已完成同步。

## 5. 如何诚实地形成差异点与评价

上述材料支持建立工程基线，不足以证明首创性。可以提出并验证以下机制假设：

> 对同一校园事项的一组原始、补充、延期、取消和冲突通知，采用“显式版本关系 + 字段证据 + 校验后应用变更 + 交接确认”，能减少遗漏和错误覆盖，并控制用户校正成本。

建议对照为：人工任务板；单通知抽取后新建任务；带简单最新文本覆盖的抽取流程；完整机制。各组使用同一批通知序列和人工标注真值。先做离线机制比较，再做小规模用户测试；不得把小样本可用性结果写成普遍显著效果。

至少分开统计：应执行事项/材料的遗漏率、错误应用的字段变更、错误合并/漏合并、无人确认的交接、用户校正时间、澄清次数、重复副作用。人工判断与系统建议都保留记录，不能只统计用户最终修正后的准确率。

在正式论文或开题前仍需补充独立的学术检索：通知管理、邮件/消息任务提取、动态任务规划、provenance-aware agents、mixed-initiative planning、协同责任与交接等。此笔记不宣称已经覆盖这些研究领域。
