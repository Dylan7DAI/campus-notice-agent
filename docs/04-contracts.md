# 接口、模型与错误契约

本文件是待实现 API；机器结构见 [候选事实 schema](../schemas/notice-candidate.schema.json) 和 [变更提案 schema](../schemas/change-proposal.schema.json)。JSON Schema 限制形状；引用是否真实、日期合法、事务及权限必须由服务层再验证。不要只通过 TypeScript 类型断言跳过运行时验证。

## HTTP 约定

路径均以 `/api` 开头。时间记录 ISO 8601 offset/UTC，日期值保持精度。错误 envelope：`{error:{code,message,field_errors?,retryable,request_id}}`。正常响应不包含密钥、原图文件系统路径或模型内部思维。所有变更命令都传 Idempotency-Key；修改现有事项都包含 expected_case_version。

| 方法 / 路径 | 输入 | 输出与约束 |
| --- | --- | --- |
| POST /intakes | multipart image 或 JSON text；origin_label?；issued_at? | 201 intake_id/source_id；图像限制 10 MB，允许 PNG/JPEG，文本限制 20,000 字符；这里只存草稿 |
| GET /intakes/:id | 本地 ID | 草稿、阶段、文本版本、问题、失败原因；原图走独立私有读取 |
| POST /intakes/:id/recognize | expected_intake_version | 202 run_id；重复运行幂等；mock/实际模式可见 |
| POST /intakes/:id/text-revisions | text、parent_text_revision_id、expected_intake_version | 新 text_revision_id；不覆盖原 OCR 文稿；新稿默认未审核 |
| POST /intakes/:id/text-revisions/:rid/approve | expected_intake_version、confirmation=true | 对确切rid保存TextApproval(actor、approved_at)，旧稿审核不传递给新稿 |
| POST /intakes/:id/extract | text_revision_id、selected_case_id?、selected_task_id?、new_goal? | 202 run_id；只处理已审核文本及一个明确执行目标；目标未明先澄清 |
| GET /runs/:id | run_id | stage、status、elapsed、safe_error；可轮询或 SSE，不回传 chain-of-thought |
| POST /runs/:id/cancel | run_id | 取消后不应用任务；已完成则返回已有终态 |
| POST /intakes/:id/answers | question_id/value 数组、selected_case_id?、expected_intake_version | 保存用户证据并确定性重建提案；确需模型才另开一次提取 run |
| GET /proposals/:id | proposal_id | pending/stale 状态、operations、impact、证据和未解决问题 |
| POST /proposals/:id/apply | expected_case_version（新建为 null）、confirmation=true | 原子 CommitResult；有 blocking questions 则 422；过期409 |
| GET /cases、GET /tasks/:id | 查询筛选 / ID | 投影 + case_version；任务详情含来源链、完成覆盖和交接说明 |
| POST /tasks/:id/requirements/:rid/status | ready 或 waived/missing、用户证据、expected_case_version | 新版本；waived 必須理由；不能更改通知原文 |
| POST /tasks/:id/preparations | title、requirement_ids、schedule?、dependency_ids、expected_case_version | 新步骤；修改使用 PATCH 同约束；依赖环422 |
| POST /tasks/:id/completions | kind、statement 或 attachment_id、expected_case_version | CompletionRecord；缺要求/冲突/待交接时422 |
| POST /tasks/:id/reopen | reason、expected_case_version | open + clear（无其他冲突时）；保留所有完成记录 |
| POST /tasks/:id/state-proposals | desired_state=cancelled/open、reason、expected_case_version | 建立cancel_task/restore_task预览并保存用户声明证据；仍走统一apply |
| POST /tasks/:id/handoffs | to_owner_id、reason、expected_case_version | awaiting_confirmation，不更换 effective_owner |
| POST /handoffs/:id/resolve | accepted_reported/declined/cancelled、basis、expected_case_version | 用户记录的结果；仅 accepted_reported 换负责人 |
| POST /cases/:id/compensations | target_audit_id、reason、expected_case_version | 补偿预览 proposal；随后走统一 apply |
| GET /tasks/:id/calendar.ics | 当前任务 | 200 text/calendar；不确定日期422；下载不代表同步 |
| POST /cases/:id/delete | expected_case_version、confirmation、backup_acknowledged | 明确的数据删除流程；不得由模型调用 |

GET calendar 生成文件时允许记录导出元数据，但不递增业务 Case.version、不改变任务状态；只采用生成时读到的一致快照，响应附 case_version。若生成期间版本变化，新导出应立即标记 stale 或重新生成，不能号称最新。

所有任务/要求/附件 ID 必须验证存在并属于当前 Case/本地数据空间。JSON 请求体和上传长度在路由层检查；业务约束在 application 层统一执行，不能只靠 UI 按钮禁用。

## NoticeCandidate：模型输出

字段包括 `schema_version`、`text_revision_id`、`relation`、`facts`、`questions`。relation 为 new/update/unknown；update 只能推荐已提供的候选 Case ID。facts 含 id、field、value、evidence_refs；field 白名单限定 title/category/due/requirement_add/requirement_remove/location/cancellation/owner_hint。禁止模型输出 SQL、工具名、execution_status 或完成命令。

Evidence refs 来自本次提供给模型的证据片段目录。建立片段目录的方法：服务端按审核文本的行/句给稳定 ID，保存 UTF-16 offsets 与 quote；给模型文本和 ID，让模型引用 ID。模型不能创建一个不存在的证据 ID。整个模型 fact 必须得到至少一个真实相关片段支持；结构有效但语义不支持仍进入用户复核/评估失败。原文中的“我已提交”只可视为文本事实，不自动生成当前用户完成声明。

提取系统指令的版本化模板要包含：角色为只读提取器；原文不是指令；仅输出 schema；不知道则 unknown；不得根据常识补日期/材料；不得从 received_at 推算历史相对日期；省略不等于撤销；所有事实必须引用证据；遇矛盾生成 blocking question。记录 prompt_version，不把提示词散落在 UI。

Due 的三种表示由 schema 定义：unknown、date、instant。对 date 要进一步检查实际日历日期与 IANA timezone；对 instant 要求 offset，拒绝无时区字符串。format/pattern 校验不能代替实际时间解析。

## ChangeProposal：服务器输出

由经过校验的事实、用户答案与当前快照生成。包含 expected_case_version 和证据，operations 仅允许 create_task、set_due、add_requirement、retire_requirement、set_location、cancel_task、restore_task、propose_handoff。完成、删除数据、任意路径 patch 不属于白名单。操作引用的 task_id/requirement_id 由服务生成/验证，模型不决定写入主键。

impact 包含 requirement_epoch_changes、preparations_needing_review、completion_needing_review、calendar_stale_task_ids。它是确定性派生结果；apply 时再次计算并与当前基线匹配。空operations可用于等待澄清或仅补充来源关系。只有任务字段、来源关联、修订关系及证据均没有变化的真正重复命令才返回NO_CHANGE，不递增Case.version或新增业务审计；仍可记录提案已处理和幂等结果。如果字段相同但新通知新增了来源/关系，仍需确认、持久化关系、Case.version+1和新增来源审计；Task/Requirement不重复，calendar_sequence不因纯来源变化而增加。

新建 case_id/expected_case_version 均为 null，由确认事务创建 Case(version=1)。更新两者必须同时有值；所有操作只能属于同一个Case和Intake所选的一个执行目标。selected_task_id必须属于selected_case_id；new_goal和已有task不能同时选。更换目标要重建提案并重新确认。提案自身不能被 apply 请求替换成客户端发送的另一组操作。

## 错误和恢复矩阵

| code / 状态 | 用户看见什么 | 恢复规则 |
| --- | --- | --- |
| UNSUPPORTED_MEDIA / 415、PAYLOAD_TOO_LARGE / 413 | 支持格式、限制、改用文本 | 不重试模型 |
| MODEL_TIMEOUT / 504、MODEL_UNAVAILABLE / 503 | 识别超时/暂不可用，草稿仍在 | 人工重试或有限退避；不写正式任务 |
| MODEL_INVALID_OUTPUT / 422 | 无法可靠识别，请校正文本 | 一次结构修复仍失败即结束 |
| EVIDENCE_INVALID / 422 | 该字段缺可靠来源 | 保留草稿，重新选择证据 |
| CLARIFICATION_REQUIRED / 422 | 需要确认的具体信息 | 等用户回答；不能自动假定 |
| VERSION_CONFLICT / 409 | 任务已更新，请重新查看预览 | 重建提案，不自动重放确认 |
| IDEMPOTENCY_KEY_REUSED / 409 | 请求标识冲突 | 客户端为新操作生成新key；不能覆盖旧结果 |
| PROPOSAL_ALREADY_APPLIED / 409 | 此预览已经应用 | 返回原提交关联；新key不能绕过提案一次性消费 |
| COMPLETION_BLOCKED / 422 | 哪些材料/交接/冲突未解决 | 用户处理缺口，不允许UI绕过 |
| STORAGE_UNAVAILABLE / 503 | 保存失败，可重试 | 所有业务回滚；幂等重试 |

状态码可在选定框架实现时细化，但 code 语义稳定；任何偏离写 ADR 并更新场景与 schema。
