# M3 验收记录（2026-09-27）

## 已通过

- `npm run check`：通过。
- `npm run test:unit`：5 个测试通过。
- `DATABASE_URL=file:./data/m3-acceptance.db npm run test:integration`：7 个测试通过。
- `npm run test:e2e`：1 个 M2 主路径测试通过。
- `npm run build`：通过。

## 未通过/未实现

- E01–E24 真实场景 runner：未实现，因此不能判定 24 个场景通过。
- E18/E19 故障 adapter 注入：未实现。
- E21 独立 ICS 解析器验收：未实现；当前只有编码单元测试。
- 完整通知来源关系、补偿提案、准备计划影响和完成/交接 API 链路：未覆盖。

## 结论

M3 当前为 **未通过**。本次结果证明构建、基础单元/集成测试和 M2 浏览器路径正常，但不满足“E01–E24 全部真实 runner 断言通过”的 M3 准入条件。

机器可读结果见 `evals/runs/m3-acceptance-2026-09-27/summary.json`。

## 交付收束（2026-10-01）

新增 `npm run eval:offline`。命令会校验 E01–E24 fixture，并在没有真实应用命令绑定时为每例写入 `not_run` 后以 exit 1 结束；本次实际报告为 24 个 `not_run`。这一步补齐了 M3 的 fail-closed 交接入口，但不改变 M3 未通过结论。
