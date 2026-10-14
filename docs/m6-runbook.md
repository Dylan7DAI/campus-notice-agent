# M6 本机故障演练与交付记录

M6 的数据保护测试只使用独立临时 SQLite 和临时附件目录。完整回归命令为：

```powershell
npm ci
npm run check
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
```

`tests/integration/m6-data-protection.test.ts` 覆盖以下演练：

- 不匹配的图片 MIME/文件头、路径穿越和跨源写入被拒绝；trace 中不保留正文、引用、模型响应或敏感字段。
- 租约过期的 `AgentRun` 被标为 `interrupted`，草稿转为 `failed_retryable`，不会自动创建事项或提交更新。
- `createBackup` 要求调用方先停止写入并传入 `quiesced: true`，执行 WAL checkpoint 后复制 SQLite 和附件，写入不含正文的 `m6-backup.2` manifest；manifest 同时记录数据库和每个附件的字节数/SHA-256。`restoreBackup` 在写入目标目录前校验 manifest、数据库 hash、附件 hash、路径和文件集合。
- `/api/cases/:id/delete` 需要当前版本、明确确认和 `backupAcknowledged`；事务内显式删除事项派生数据，引用计数为零时才清理附件。

备份工具故意没有提供公网端点。生产试用时应先停止本机写入，再调用应用层 `createBackup`；恢复应先恢复到新目录并核对任务、证据和附件，再切换 `DATABASE_URL`/存储目录。删除是不可逆操作，必须先保留备份，并且必须传入当前 `expectedCaseVersion`、明确确认和 `backupAcknowledged`。

当前限制：没有实现跨进程锁或自动定时备份；`createBackup` 的一致性依赖调用者履行停写约束，恢复不会自动运行迁移，也不会替换外部日历。尚无跨进程停写或掉电级恢复演练证据，因此 M6 保持 `partial`。日志只保证本项目结构化 trace 的脱敏，操作系统、Next.js 和 provider 自身日志仍需单独配置。测试使用独立临时目录，不删除用户数据库。

## Prompt 3 本地回归记录（2026-10-10）

- `redactTrace` 只保留明确的运行 ID、状态、阶段、错误码、provider/model 等安全字符串；正文、提示词、响应、引用和未知字段字符串均替换为长度标记。
- 备份 manifest 升级为 `m6-backup.2`，包含附件逐文件 hash；恢复先校验数据库、附件、路径和文件集合，再通过临时目录写入目标。篡改附件或非法 manifest 不会创建目标数据库。
- 删除命令现在强制要求当前 `expectedCaseVersion`；共享文本/附件仍在存在其他事项引用时保留。

本轮新增回归覆盖：非法图片大小、任意字段正文不进入 trace、manifest 附件 hash 篡改、缺失删除版本和共享材料保留。

