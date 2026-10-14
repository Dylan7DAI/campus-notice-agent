# 场景文件如何转成真正的测试

[scenarios.json](scenarios.json) 是设计验收 DSL，**当前没有应用runner**。`node scripts/check-spec.mjs`只审计结构和证据片段，不能执行这些业务断言。M3需要实现下述绑定，不能将 expect 复制为 actual。

## 结构与隔离

- 每个case从空的临时SQLite开始，执行真实迁移，再把given.state导入repository。不得连用户DB。given.clock注入Clock，fixture_ids注入IdGenerator。
- given.state按ID组织是便于阅读的规范化数据，不要求DB列名相同。applied_notice_ids表示已采纳的来源关系；不要因fixture字段名字而随意新增冗余表。
- given.fixture_language、assertion_projection和required_test_adapters是runner元数据；不得传给产品API。默认deterministic_fixture只替代模型provider，不替代领域引擎/事务/ICS编码。
- 每一步when调用实际application command或HTTP，capture_as命名一个不可变快照。`$draft.proposal.id`表示从此前检查点取值；不能引用未来检查点。同名capture禁止。
- expect.assertions使用RFC6901 JSON Pointer与严格深比较。数组按契约确定排序；不得排序掉业务顺序错误。缺字段是断言失败；预期null要由投影明确产生null，不能任意吞掉异常。

## DSL动作绑定

| 动作 | 必须调用的真实路径 |
| --- | --- |
| propose_from_reviewed_notice | 验证所选Case/Task与已审核文本，使用可预测提取adapter，再经真实证据校验、差异/影响计算生成提案；reviewed_text_revision_id表示用户明确审核该版本，应先调用approve命令 |
| confirm_proposal / confirm_create_case | 统一apply命令，携带confirmation、预期版本和幂等key；严禁直接写最终快照 |
| upload_duplicate_artifact / receive_existing_notice_again | 输入去重和接收逻辑；接收时间不改变通知生效先后 |
| correct_text_revision | 建立未审核的校正稿与新notice引用；旧稿保留；后续明确审核才能提取 |
| approve_text_revision | 用户针对确切text_revision_id执行approve，校验Intake版本，保存独立TextApproval；重试不能生成第二份审核 |
| answer_proposal_question | 保存用户答案证据并重建提案，不能修改旧proposal |
| set_requirement_status / record_completion | 材料状态或完成命令；触发版本及完成一致性重算 |
| request_handoff / record_handoff_acceptance | 本地交接命令；记录者是local_user，不模拟实际向别人发送 |
| record_local_reminder_display / open_task_detail / evaluate_local_reminders | 真实提醒展示/读取投影；不能触发完成 |
| export_calendar | 逐个调用单任务导出，使用实际ICS编码器；独立解析输出检查字节与语义；未知日期收集422 |
| user_request_cancellation | 从用户声明建立cancel_task提案；仍须后续confirm |
| propose_compensation | 对目标审计事件生成基于当前状态的补偿预览；不能直接倒回旧库 |
| fixture_commit_concurrent_owner_change | 测试帮助函数调用正常负责人与版本命令，模拟另一操作；不是绕过版本控制的原始DB更新 |
| invoke_fixture_extractor / validate_fixture_extraction / validate_fixture_evidence_catalog | 故障/恶意输出仅由测试adapter提供，必须走产品的schema/证据/预算验证器 |
| manual_review_and_propose | 用户校正并明确approve后，再进入真实提案流程 |
| set_fault_injection / clear_fault_injection | 仅测试环境在指定事务阶段抛错；生产构建不暴露HTTP故障开关 |

如果字段缺失或领域定义不一致，runner应fail并说明，不补造默认为成功的值。fixture中的非法候选/伪引用是负例，不应为使schema通过而“修正”。新的语义变更先修规格及相应gold，再独立修改实现并保留原因。

## 检查点投影

checkpoint统一提供response（HTTP状态/错误/返回值）、state（从真实DB重新查询）、metrics（实际计数）、view（与UI共用的只读业务投影）、calendar（从实际ICS字节解析）。它们是测试观察窗口，不要求产品HTTP返回整个内部数据库。

- `new_audit_event_count` 是相对初态的增量；其他 `*_count` 是该隔离案例实际集合计数。
- `view.tasks.*.current_requirements_completed` 必须由完成记录覆盖、active材料和冲突/交接条件计算；不是execution_status字符串比较。
- `calendar.parsed.events`按任务ID汇总，缺省DTEND显式映射为null；取消状态和UID读实际内容。检查CRLF与折行必须直接读取原始bytes，不能只检查解析后的字符串。
- `source_notice_ids`只包含已采纳的来源关系，不能把所有上传草稿当成已应用来源。
- HTTP“200”与状态断言要分别验证；发生超时/409/503的案例也必须读取DB证明未误写。

尚无实际截图质量数据；case中synthetic私有文件key和固定hash可作为repository种子，但不证明附件字节正确。真实上传/去重测试要创建实际bytes并计算SHA-256；M4图片评估另附真实合成图像，不能把本文件的文本替代图像输入。
