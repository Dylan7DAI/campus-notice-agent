# 借鉴前人的工作：依据、转化和边界

核对日期2026-09-24。已读取公开源码、标准和工程原文；未运行Donetick，也未完成系统学术综述。详细记录见 [开源与标准笔记](../research/reference-notes.md) 和 [Harness原文笔记](../research/harness-notes.md)。

| 一手来源 | 已核实机制 | 本项目采用 | 不能据此声称 |
| --- | --- | --- | --- |
| [Donetick README](https://github.com/donetick/donetick/blob/0fb2a3cd017a6efb6a779f262dfef68357d4d011/README.md) | 英语自然语言创建、分工与轮换 | 可编辑字段、任务板、明确负责人 | 已验证中文通知准确率 |
| [Donetick调度源码](https://github.com/donetick/donetick/blob/0fb2a3cd017a6efb6a779f262dfef68357d4d011/internal/chore/scheduler.go#L350) | 历史完成间隔指数衰减加权，decayFactor=0.5 | 将习惯辅助安排和通知硬截止区分 | 通用AI规划或理解通知变更 |
| [Donetick图片转任务源码](https://github.com/donetick/frontend/blob/944d1b34470971f5987c1a6dd9a28bc586147971/src/views/components/ScanToTask/useScanToTask.js) | 英语OCR→模型→至多一项任务建议，含School Form例子 | 识别结果进入可编辑草稿 | 截图转任务是本项目新发明 |
| [W3C PROV-DM](https://www.w3.org/TR/prov-dm/) | Entity、Activity、Agent及派生/修订 | 不可变原文、校正活动、字段证据、责任区分 | 来源链自动证明真实性或已完整兼容PROV |
| [LangGraph Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)与[Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | 暂停/恢复、检查点；恢复可能重跑节点 | 持久化草稿、澄清、幂等提交 | 框架自动提供事务正确性或必须引入框架 |
| [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545) | UID、SEQUENCE、日期精度、编码 | 稳定日历身份和有效ICS文件 | 文件下载即远端同步或必定覆盖旧条目 |
| [Anthropic长期Agent Harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | 初始化环境、功能清单、增量会话、交接、浏览器检查 | M0、任务卡、progress、E2E | 一个长prompt足够或多Agent必然更好 |
| [Anthropic Agent评估](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | trial、评分器、轨迹、最终环境状态、隔离 | 以实际DB状态评分，mock与真实模型分开，失败进入回归 | 回复成功就等于真实任务成功 |
| [OpenAI AGENTS.md](https://developers.openai.com/codex/guides/agents-md) | 文件发现、分层覆盖、默认32KiB合并上限 | 短入口、按任务读详细规格 | 所有工具自动读agent.md或存在链接就已读正文 |

## 差异定位

本项目的工程组合是：**显式通知修订关系 + 字段证据 + 差异及影响检查 + 完成条件版本化 + 本地交接记录**。对应的问题是：变化通知到来后，同一任务是否仍然正确，用户能否看见哪里尚未完成？

这是一项待检验的设计假设。限定读取中未发现某竞品的机制，不代表其整个产品没有，也不构成学术新颖性证明。若用于开题/论文，应继续检索通知管理（notification management）、邮件/消息任务提取（email action item extraction）、mixed-initiative planning、provenance-aware agents、动态约束/任务修订、协作责任/交接，并逐篇比较问题、方法、评价与局限。

## 复用策略

Donetick前后端核对版本均使用AGPLv3。默认借鉴机制并独立实现。若fork、复制或改编代码，登记文件/提交、保留许可并评估分发及远程网络使用涉及的对应源码义务。没有运行其产品，因此不把源码读取称为用户体验比较。

W3C和RFC提供设计与互操作依据，本包未嵌入整套标准实现。来源版本写入笔记，替换框架或复制组件时更新ADR和来源。

## 阅读限制

OpenAI [Harness engineering](https://openai.com/index/harness-engineering/) 页面本次直接请求遇访问挑战，未核实正文；本包不以其未读内容作事实依据。Harness建议采用上述已实际读取的官方资料及明确标注的项目设计推论。
