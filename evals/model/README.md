# M4 模型评估语料

`manifest.json` 包含 30 个互不重叠的合成通知事项，每个事项有两张版本图片，按事项划分为 20 个 development 和 10 个 heldout。图片只含合成字段，不含个人通知正文；评估默认只跑 heldout，并要求同一封存集重复 3 次。

语料已封存。`generate:model-corpus` 仅用于另行批准的语料修订，不能为了改善分数重建当前图片或 gold：

```text
npm run generate:model-corpus
```

使用真实 provider 评估：

```text
npm run eval:model
```

默认 `--sequence=initial_to_update` 按图片顺序逐版识别和提取。初版没有已有目标，预期为 `new`；第二版使用明确的只读评估目标 `eval-Cxx`，预期为 `update`，关系引用须支持可见的 `UPDATE VERSION 2`。初版 `new` 的关系引用可以为空（候选契约允许）；所有非空引用仍必须属于当前文本版本。版本 ID 同时包含事项、重复轮次和图片序号。

第二版上下文来自初版实际通过结构、字段证据及关系校验的候选，不用 gold 替代失败输出，也不创建正式任务。上下文明确标为未确认；初版需要澄清时仍可作为只读候选上下文，绝不当作已提交事项。初版无有效上下文时第二版为 `not_run/PRIOR_REVISION_INVALID`；所有预定版本（包括失败、未运行和中断时尚未执行的版本）保留在指标分母内。报告每完成一版保存一次，中断报告保持 `incomplete`，不能冒充完整运行。

可用 `--set=development|heldout`、`--case=C28`、`--limit=N`、`--repeats=N` 做受控冒烟。C28 初版失败应使用默认顺序模式；`--sequence=latest_revision_only` 只使用第二张图片，不能重现该初版输入或作为完整序列验收。为比较历史 m4.3 使用的识别/提取模型，可在 PowerShell 临时设置 `$env:MODEL_NAME='glm-4.5v'`；这不修改 `.env.local`。

2026-10-09 评估 prompt 为 `m4.4-eval`（原 m4.3 基础模板加具体 JSON 类别/位置和 schema 反馈），最终 evaluator 为 `m4-sequence.4`（未知属性只报告父路径，JSON 偏移仅接受原生位置后缀且检查范围）；应用中文 prompt 仍为 m4.3。请求与应用一样设置 4000 token 上限；不改变 60 秒请求、240 秒运行、3 次调用及一次重试/修复边界。输入/响应 hash、四个 evaluator 模块的合并 hash 和分段耗时明确记录变化，不能把英文评估等同于生产中文提示词。

开发排查先跑不联网的虚拟时间超时/结构回归，再定向真实冒烟，稳定后才跑完整封存集三轮。首次定向运行加 `--save-replay` 可在该运行目录保存合成语料的实际 OCR 文字及图片/文字 hash；这不是原始模型响应或思维链，默认不保存。随后只重放初版提取，省去重复 OCR：

```powershell
$env:MODEL_NAME='glm-4.5v'
npm run eval:model -- --case=C28 --repeats=1 --save-replay
npm run eval:model -- --case=C28 --repeats=1 --stage=extraction --replay=evals/runs/<run-id>/C28-r1-v1-ocr.json
```

重放接受带有本地 OCR 来源声明的该事项第一张图片文件，核对图片、文字 hash 和长度；hash 证明一致性，不独立认证来源。不从 gold 创建输入。报告为 `extraction_replay_diagnostic`、`quality_comparison_eligible=false`，全部正式验收标志为 false，不能与完整运行混合成绩。重放文件只用于本地合成语料诊断，不收录个人通知，清理时删除该次运行目录即可。

报告写入 `evals/runs/<run-id>/summary.json`。缺配置、空筛选或任何失败/未运行都返回 exit 1；不挑选最好的一次。包含每版 actual/expected/diff、逐轮指标、“全部三次正确”的事项比例、调用/修复/网络重试数、分阶段结构错误路径与代码、JSON 错误类别/UTF-16 位置（不含原生错误片段）、每次请求/响应体耗时、HTTP 状态、输入/响应 hash、token usage，以及未知费用。默认不保存原始模型响应、图片、密钥或思维链。回归中的 provider stub 和虚拟时钟只证明控制流，不算真实模型成绩。

关键事实和证据各按每版 5 个事实计分；due 必须保持 date 精度、Asia/Shanghai 和 inclusive（对应冻结生成器的可见字段），证据引用要支持完整 due 对象的日期/时区/边界。关系正确率另列；多余/重复事实、错目标、假引用和遗漏澄清均使该版失败。报告同时包含每次重复的指标、无必要澄清率和 Wilson 95% 区间；同事项各版/各次并非独立样本，区间只作描述，不能据此推断普遍质量。旧报告的证据分母是“样本”，新报告是“事实”，不能直接混合汇总。

现有第二版仅比第一版多一行版本标记，业务字段没有变化。顺序评估覆盖版本关系和字段保持，尚不能证明延期、撤销、材料变化、乱序、同名错连或不同图片质量的识别质量。语料也没有两人独立标注记录、发布/接收时刻或完整既有任务/完成/负责人标签；这些不足须单独报告，不能通过改写 gold 补成实测证据。

本 runner 直接调用 provider，未经过人工 OCR 审核、应用预览/确认、CAS 或写库路径。因此 `commit_attempted=false`，`false_auto_commit=null`，自动提交检查为 `not_run`，`m4_complete=false`；模型点估计达标也不能单凭此报告宣布 M4 完成。应用事务、安全和无确认写入需要另行审计；E01–E24 离线结果与真实模型成绩分别报告。
