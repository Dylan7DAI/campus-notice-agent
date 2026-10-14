# M5 日历、准备与交接验收记录

M5 已接通本地任务详情投影、准备步骤、交接状态和 ICS 导出。页面显示日期级截止、时刻级截止、负责人、准备计划、历史事件和旧导出失效提示；写命令仍经过应用事务和 case version 检查。

## 可复现证据

- `tests/integration/m5-calendar.test.ts` 使用临时 SQLite 验证：导出写入 `CalendarExport`，截止日期变更后旧 sequence 标记 `stale`，准备步骤冲突标记 `needs_review`，未知日期不产生导出元数据。
- `src/app/api/tasks/[id]/calendar.ics/route.ts` 在同一事务读取任务快照并写导出元数据，响应返回 `x-case-version` 与 `x-calendar-sequence`。
- `src/app/page.tsx` 提供准备步骤保存、交接接受/拒绝/取消、任务历史、date-only/instant 展示和 stale 提示。

## 仍未完成的外部兼容性试验

本机没有安装或连接 Outlook、Apple Calendar、Google Calendar 等实际客户端，也没有额外 ICS 导入库；因此本轮没有把 RFC 语法 round-trip 当成客户端行为证据。M3 的本地 `parseIcs` 只能验证编码器的结构回读，不能证明重复导入、取消事件或 stale sequence 会被某个客户端遵守。

正式完成 M5 前，需要在受控本机环境记录至少两个实际客户端或独立导入 parser 的名称和版本，分别导入 date-only、instant、SEQUENCE 增长和 `STATUS:CANCELLED` 文件，并记录重复导入、取消和旧条目是否实际更新。持续同步和后台送达仍不在范围内。

## Prompt 2 本地链复核（2026-10-10）

### 本轮修改

- 准备步骤保存现在先检查幂等结果，再校验标题、同一任务内的依赖和要求 ID；不存在或跨任务依赖以 `PREPARATION_DEPENDENCY_NOT_FOUND` 失败，依赖环仍以 `PREPARATION_DEPENDENCY_CYCLE` 失败。
- 准备计划按 Due 的 IANA 时区比较日期级截止，instant 仍按带 offset 的时刻比较；延期不会移动已有计划，只更新 `planState`。
- 同一任务已有待确认交接时拒绝第二个请求（`HANDOFF_ALREADY_PENDING`）；拒绝、取消、接受均保留历史，只有 `accepted_reported` 更新有效负责人。
- UI 增加取消提案确认入口。确认后任务状态为 `cancelled`，重新导出 ICS 产生稳定 UID、递增 SEQUENCE 和 `STATUS:CANCELLED`；旧导出在重新导出前显示 stale，当前导出成功后任务板不再把历史 stale 当作当前导出失效。
- 新增真实 route handler + 临时 SQLite 回归，覆盖准备幂等/依赖失败、交接拒绝/取消/接受和用户重复待确认失败；E2E 覆盖取消预览/确认、stale 提示和取消 ICS。

### 实际命令与退出码

| 命令 | 实际结果 | 证据 |
| --- | --- | --- |
| `npm run test:unit` | exit 0；5 files / 16 tests passed | Vitest stdout（本轮快速回归） |
| `npm run test:integration` | exit 0；8 files / 32 tests passed；脚本创建并清理独立临时 SQLite | `tests/integration/m5-calendar.test.ts`；临时目录由 `scripts/test-integration.mjs` 管理 |
| `npm run test:e2e` | 最终 exit 0；2 tests passed；约 11.5s；Chrome executablePath | `tests/e2e/m2.spec.ts`；Playwright 临时库由 `scripts/test-e2e.mjs` 管理 |
| `npm run check` | exit 0；TypeScript、ESLint、规格静态检查通过 | `scripts/check-spec.mjs` 静态输出 |

### M5 状态

本地 API/UI 链和确定性测试通过。M5 仍为 **partial**：当前环境没有 Outlook、Apple Calendar、Google Calendar 或独立 ICS 导入库的版本化导入记录，因此没有声称客户端兼容性、重复导入、取消传播或 stale sequence 已通过。完成 M5 仍需至少两个具体客户端/解析器名称和版本的实际导入报告。

初次把取消操作改为 UI 点击时，E2E 发现同一临时库中已有两项任务，未限定任务行导致 `getByRole('button', {name: '预览取消'})` strict mode 失败（exit 1）。已将操作限定在当前任务行，最终 E2E exit 0；没有放宽断言。
