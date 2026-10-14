# 领域规则：唯一语义依据

## 术语与数据关系

`Case` 是同一校园事项的聚合根；一个事项可有多个任务和多条通知。`NoticeRevision` 是不可变通知版本，不等于上传次序。`Task` 是稳定的执行目标，例如提交某次奖学金申请。`Requirement` 是完成该目标必须满足的要求。`Preparation` 是用户准备步骤，不自动成为原通知要求。

MVP每次提取和提案只处理**一个由用户选择的执行目标**。Intake保存selected_task_id或明确的新建目标描述；同一通知含“报名截止”和“活动开始”时，必须分成两个目标分别预览确认，可以复用同一原图。目标不明确则先澄清，不把所有日期赋给第一个任务，也不静默忽略第二个目标。Case可有多个任务，但一次提案的operations只作用于被选中的一个Task；确认事务仍锁定整个Case。

| 实体 | 必备字段 / 约束 |
| --- | --- |
| Case | id、title、category、version（整数，从 1 起；所有业务写入递增）、created_at |
| SourceArtifact | id、sha256、media_type、private_storage_key、received_at、origin_label、size；内容不可覆盖 |
| TextRevision | id、source_id、parent_text_revision_id?、text、method=vision/manual、created_at；校正产生新版本 |
| NoticeRevision | id、case_id（草稿可空，采纳时绑定）、text_revision_id、issued_at?、issuer?、supersedes_ids、relation_evidence_ids；发布先后只是线索 |
| Evidence | id、source_id、text_revision_id、quote、start/end（JS UTF-16 半开区间）、bbox?、origin=notice/user_decision；quote 必须等于 text.slice(start,end) |
| Task | id、case_id、category、title、execution_status、consistency_status、due、location?、requirement_epoch、effective_owner_id?、calendar_sequence |
| Requirement | id、task_id、label、active、satisfaction=missing/ready/waived、evidence_ids、introduced_by、retired_by?；waived 须理由及用户证据 |
| Preparation | id、task_id、requirement_ids、title、start?、end?、duration_minutes?、dependency_ids、status、plan_state=valid/needs_review、user_evidence_id |
| CompletionRecord | id、task_id、covered_epoch、covered_requirement_ids、kind=user_attested/receipt_attached、evidence_ids、recorded_by=local_user、created_at；不可改写 |
| Handoff | id、task_id、from_owner_id?、to_owner_id、status、recorded_by=local_user、basis_evidence_id、created_at |
| ChangeProposal | id、case_id?、expected_case_version?、notice_ids、operations、impact、questions、status、created_at；修改产生新 proposal |
| AuditEvent | id、case_id、case_version、command_id、actor、event_type、before/after_minimal、evidence_ids、created_at |
| CalendarExport | id、task_id、uid、sequence、case_version、generated_at、sha256、stale |
| CommandResult | idempotency_key、scope、payload_hash、response_json、committed_at；与业务提交同事务 |

证据原文用于证明“通知写了什么”，不验证通知的真实性。手机号、学号等非必要身份字段不抽取。暂不识别截图作者的真实身份；origin_label 由用户标注。

Evidence的存储形状统一，但来源类型严格区分：origin=notice引用通知自己的TextRevision；origin=user_decision必须先把该用户答案/声明保存为独立的text/plain SourceArtifact与不可变TextRevision，再引用其真实quote/span，origin_label=本地用户。ClarificationAnswer指向这份用户文本与question_id、recorded_at；不能把用户的撤销理由伪装成通知原文。提案notice_ids是上下文来源，用户操作授权证据可以来自user_decision。

## INV-01–04：原文、版本、权限

原图、OCR/视觉识别稿与校正稿分别保留。识别出的一段文字只有用户审核后才可当作可靠提取来源；模型给出的 span 必须做字符串一致性验证。bbox 可选，没有可信定位时只展示文本引用，不伪造图中高亮。

事项匹配先按用户选择的已有 Case 或明确原通知关联；标题、日期、发布单位等只能推荐，**不能凭相似度自动合并**。新上传旧截图不覆盖当前要求。同一份图片以 sha256 去重可复用 artifact，但不同上传行为和来源说明可单独记录；文本相似但图不同不得自动当作相同通知。

“以本通知为准”仅作用于已确认同事项、同作用范围；不得清空没有被显式替代的全部要求。两个来源互相矛盾且无明确取代关系时生成 conflict，保留两个候选，用户决定采纳哪一个并写入 user_decision 证据。

所有生成与更新采用 propose → review → commit。未经确认的候选、失败的解析、未完成的澄清都只在草稿区。确认属于应用用户动作，不属于通知文本，也不由模型代为产生。

## INV-05、09、10：一致性提交

单条业务命令以 Case 为事务边界。确认命令包含 `proposal_id + expected_case_version + Idempotency-Key`。同 key 同 payload 返回第一次保存的结果；同 key 不同 payload 返回 409 IDEMPOTENCY_KEY_REUSED。**先查幂等结果，再做版本比较**，使重试不受已提交版本变化影响。

不存在已提交结果时，服务端在同一事务内：读取 Case 及 proposal → 验证 proposal 仍 pending、归属和全部前提 → compare-and-swap version → 应用白名单操作 → 计算影响 → 插入审计、幂等结果 → 提交。失败全部回滚；不留半更新的材料或状态。SQLite busy 可有限重试事务 2 次，不能重跑模型。

该事务还必须把proposal.status置为applied，并写入唯一的ProposalApplication(proposal_id, command_id, applied_case_version)。同一proposal换新幂等key再提交返回409 PROPOSAL_ALREADY_APPLIED；同key同payload重试仍优先返回第一次结果。这些内部提交元数据与ChangeProposal对外JSON形状分开，不擅自扩展schema。

任何相关用户修改（材料、准备、完成、负责人、撤销）都递增 Case.version，使旧预览失效。客户端不能传自定义 operations 直接写库。新建 Case 的确认以 intake_id + command key 唯一约束防止重复提交。

## INV-06、07：完成语义

execution_status：open、in_progress、completed、cancelled。consistency_status：clear、needs_review。任务板优先展示 cancelled，然后 needs_review，然后 execution_status；不得把 `completed + needs_review` 渲染为已经满足新版要求。

完成必须由用户执行 record_completion 命令，有自述“我已完成/提交”或收据附件；系统表述为用户声明/所附证据，不能声称已经向学校核验。所有 active requirements 必须 ready 或有理由的 waived，相关交接不能等待接受，未解决的关键冲突必须为零；否则返回 422 COMPLETION_BLOCKED。准备 ready 只代表材料具备，真正提交仍需单独完成声明。

requirements 的增删、资格条件改变、提交方式改变，会增加 requirement_epoch（从1起；同一事务对同一任务最多递增1次）。旧 CompletionRecord 保留；若已完成任务的 covered_epoch 落后，consistency_status=needs_review。用户在新版要求满足后可“记录补充完成”，产生新记录，或“重新打开”继续办理；不得直接改旧记录。仅延期不使完成失效，提醒已完成者可保持完成。活动地点改变是否影响完成取决于任务类型：尚未参加的活动更新执行地点；已完成的参与任务默认需复核，不能猜测是否需再次参加。

提醒 delivery 状态是独立日志。生成 ICS、查看详情、点击提醒或发起交接均不产生 CompletionRecord。

每个可能影响完成前提的命令都重新计算一致性：已completed任务的active材料从ready改回missing、撤销waived、出现关键冲突或待接受交接，均设needs_review，即使requirement_epoch没有变化。前提恢复也不自动制造新完成证据；用户需要确认当前完成状态。领域中允许record_completion来解决“旧完成覆盖不足”这一类复核，但不能绕过材料缺失或关键冲突。

## INV-08：负责人及交接

MVP 的 Owner 是用户给自己/联系人设置的别名，不是账号。用户可直接明确指派负责人，但 UI 区分“已指定（未记录接手）”与“你记录对方已接受”。

交接状态：proposed → awaiting_confirmation → accepted_reported / declined / cancelled。只有用户以说明/证据记录 accepted_reported，effective_owner 才由 from 改为 to；拒绝/取消保持原人。若原人为空，则持续显示无人负责。通知中“由小王负责”只产生责任变更提案；它不能证明小王收到并接受。更换目标人须结束旧交接、创建新记录，不覆盖历史。

## INV-11：差异合并及准备计划

新增材料赋稳定 requirement ID；已存在材料在同一语义经用户确认后沿用 ID 和准备状态。名称相似但不确定的材料不得静默合并。仅未提及旧材料保留原要求；只有明确撤销/替代才将其 active=false，保留历史与关联证据。

准备计划检查确定性条件：计划结束是否晚于截止边界、依赖是否完成、总时长是否足够、用户提供的开放时间是否允许。发现冲突只标 needs_review 并建议新时间；**不静默搬动用户已有计划**。延期不自动推迟已安排工作；缩短截止时间必须标出受影响计划。新增证明但耗时未知时显示“尚未估计办理时间”。依赖必须无环；规则用固定 clock 与时区测试。

## 时间与 ICS

Due 为 tagged union：unknown / date / instant。date 保存 YYYY-MM-DD、timezone、boundary=inclusive/exclusive/unspecified；instant 保存有 offset 的 ISO 时间与 IANA timezone。默认显示 Asia/Shanghai；原始日期短语、发布时间和用户解析答案作为证据。

不以 received_at 推断“下周一”；已知原始发布时间且语义唯一时可提出解析候选，仍须用户确认。未明日期边界不参与精确排期；date-only inclusive 可按当地下一日 00:00 的排他边界计算，但不得显示成“原文要求 23:59”。

ICS：任务使用稳定 UID；任何导出相关变更使 calendar_sequence +1（同一事务同一任务最多1次）并把旧导出 stale=true。date-only 且边界已确认时导出全天 VEVENT（DTEND 是排他下一天），摘要注明这是日期级截止标记；instant 导出 UTC DTSTART，截止标记省略 DTEND/DURATION，按标准表示瞬时事件，不虚构办理时长。真正活动若有确定结束时间，DTEND必须晚于DTSTART。报名活动时间与报名截止时间分别用不同 task UID。取消可导出 STATUS:CANCELLED、递增 SEQUENCE，但**下载文件无法保证既有日历被更新或删除**；UI 提醒用户检查旧条目。需写 RFC5545 转义、CRLF、UTF-8 75 octet 折行、UID/SEQUENCE 测试。无明确日期不导出事件。

全天日期映射固定为“可办理的最后一天”：inclusive D → DTSTART=D、DTEND=D+1；exclusive D → DTSTART=D-1、DTEND=D。描述保留原始D及边界，避免把“9月28日之前”呈现成28日当天仍可办理。unspecified边界继续澄清，不能导出已确定的截止事件。

## 撤销、恢复与删除

撤销是对当前版本生成补偿提案，预览和确认后新增审计；不是删除历史或把 DB 整体回滚。中间已有变化时必须重新计算，禁止恢复旧快照盖掉新数据。取消不等于完成；取消保留完成历史，抑制新的待办提醒；恢复后重新检查当前要求、负责人和计划，默认 needs_review。

不可变指业务期间的历史保留，不阻止用户删除个人数据。删除事项属于显式数据操作，应先导出备份、明确显示影响，然后清除该事项的正文、派生数据和包含个人信息的审计；按哈希复用的原图/文本只在引用计数为0时清理，不能破坏另一事项的证据。保留的技术日志不得可还原正文。测试数据清理只针对临时目录。
