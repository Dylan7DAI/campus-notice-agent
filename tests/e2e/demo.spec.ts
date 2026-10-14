import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { demoSamples } from '../../src/demo/samples';

type DemoTask = {
  id: string; caseId: string; executionStatus: string; consistencyStatus: string;
  effectiveOwnerId: string | null; dueJson: string | null;
  requirements: { label: string; satisfaction: string; active: boolean }[];
  completionRecords: { id: string; statement: string; coveredEpoch: number }[];
  sources: { text: string }[];
  preparations: { title: string; planState: string }[];
  handoffs: { status: string; toOwnerId: string }[];
};

async function clickAction(page: Page, action: string, click: () => Promise<void>, endpoint = '/api/intakes') {
  const pending = page.waitForResponse((response) => response.url().endsWith(endpoint)
    && response.request().method() === 'POST'
    && response.request().postDataJSON().action === action);
  await click();
  const response = await pending;
  await expect(page.getByText('正在处理，请稍候…', { exact: true })).toBeHidden();
  return response;
}

async function readTask(request: APIRequestContext, taskId: string) {
  const response = await request.get('/api/tasks');
  expect(response.status()).toBe(200);
  const data = await response.json() as { tasks: DemoTask[] };
  const task = data.tasks.find((entry) => entry.id === taskId);
  expect(task).toBeTruthy();
  return task!;
}

test('demo image correction, completion review, preparation and local handoff', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(page.getByText('离线演示 · mock', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '上传截图' }).click();
  // A synthetic 1×1 PNG keeps this intake independent from shared text samples.
  await page.getByLabel('通知截图', { exact: true }).setInputFiles({
    name: 'synthetic-demo.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mioAAAAASUVORK5CYII=', 'base64'),
  });
  const uploaded = page.waitForResponse((response) => response.url().endsWith('/api/intakes')
    && response.request().method() === 'POST' && response.request().headers()['content-type']?.includes('multipart/form-data'));
  await page.getByRole('button', { name: '保存图片', exact: true }).click();
  expect((await uploaded).status()).toBe(200);
  await expect(page.locator('#notice-text')).toHaveValue('[图片尚未识别，请识别文字或填写人工校正稿]');
  await expect(page.getByText('正在处理，请稍候…', { exact: true })).toBeHidden();
  await page.locator('#notice-text').fill(demoSamples.original.text);
  expect((await clickAction(page, 'revise', () => page.getByRole('button', { name: /保存校正稿/ }).click())).status()).toBe(200);
  expect((await clickAction(page, 'approve', () => page.getByRole('button', { name: '确认文本无误', exact: true }).click())).status()).toBe(200);
  const candidate = page.waitForResponse((response) => response.url().endsWith('/api/demo/candidate'));
  await page.getByRole('button', { name: '生成 mock 候选', exact: true }).click();
  expect((await candidate).status()).toBe(200);
  await expect(page.getByText('正在处理，请稍候…', { exact: true })).toBeHidden();
  expect((await clickAction(page, 'preview', () => page.getByRole('button', { name: '预览提案', exact: true }).click())).status()).toBe(200);
  const confirmation = await clickAction(page, 'confirm', () => page.getByRole('button', { name: '确认并创建任务', exact: true }).click());
  expect(confirmation.status()).toBe(200);
  const created = await confirmation.json() as { taskId: string; caseId: string };
  const row = page.locator(`[data-task-id="${created.taskId}"]`);
  await expect(row).toBeVisible();
  await row.locator('summary').filter({ hasText: '准备、交接与历史' }).click();
  const statement = '我已在演示流程提交报名表（合成完成声明）';
  await row.getByLabel(`完成声明-${created.taskId}`, { exact: true }).fill(statement);
  const blocked = await clickAction(page, 'record_completion', () => row.getByRole('button', { name: '记录完成', exact: true }).click(), '/api/commands');
  expect(blocked.status()).toBe(422);
  await expect(page.locator('.notice[role="alert"]')).toContainText('请先备齐全部材料');
  expect((await readTask(request, created.taskId)).completionRecords).toHaveLength(0);
  expect((await clickAction(page, 'set_requirement_status', () => row.getByRole('checkbox', { name: /报名表/ }).click(), '/api/commands')).status()).toBe(200);
  await expect(row.getByRole('checkbox', { name: /报名表/ })).toBeChecked();
  expect((await clickAction(page, 'record_completion', () => row.getByRole('button', { name: '记录完成', exact: true }).click(), '/api/commands')).status()).toBe(200);
  const completed = await readTask(request, created.taskId);
  expect(completed.executionStatus).toBe('completed');
  expect(completed.completionRecords).toHaveLength(1);
  const completionId = completed.completionRecords[0].id;

  await row.getByRole('button', { name: /添加更新通知/ }).click();
  await expect(page.locator('#notice-text')).toHaveValue(demoSamples.update.text);
  expect((await clickAction(page, 'create', () => page.getByRole('button', { name: /保存并审核文本/ }).click())).status()).toBe(200);
  await expect(page.getByLabel('通知关系', { exact: true })).toHaveValue(created.taskId);
  expect((await clickAction(page, 'approve', () => page.getByRole('button', { name: '确认文本无误', exact: true }).click())).status()).toBe(200);
  const updateCandidate = page.waitForResponse((response) => response.url().endsWith('/api/demo/candidate'));
  await page.getByRole('button', { name: '生成 mock 候选', exact: true }).click();
  expect((await updateCandidate).status()).toBe(200);
  await expect(page.getByText('正在处理，请稍候…', { exact: true })).toBeHidden();
  expect((await clickAction(page, 'preview', () => page.getByRole('button', { name: '预览提案', exact: true }).click())).status()).toBe(200);
  await expect(page.locator('.change-preview')).toContainText('新增材料');
  expect((await readTask(request, created.taskId)).sources).toHaveLength(1);
  const updatedResponse = await clickAction(page, 'confirm', () => page.getByRole('button', { name: '确认并更新任务', exact: true }).click());
  expect(updatedResponse.status()).toBe(200);
  expect(await updatedResponse.json()).toMatchObject({ taskId: created.taskId, caseId: created.caseId });
  await expect(row).toContainText('当前条件需要复核');
  const updated = await readTask(request, created.taskId);
  expect(updated.consistencyStatus).toBe('needs_review');
  expect(updated.completionRecords).toEqual(completed.completionRecords);
  expect(updated.completionRecords[0].id).toBe(completionId);
  expect(updated.requirements).toEqual(expect.arrayContaining([
    expect.objectContaining({ label: '报名表', active: true, satisfaction: 'ready' }),
    expect.objectContaining({ label: '在读证明', active: true, satisfaction: 'missing' }),
  ]));
  expect(updated.sources).toHaveLength(2);
  expect(updated.sources.map((source) => source.text)).toEqual([demoSamples.original.text, demoSamples.update.text]);

  await row.locator('summary').filter({ hasText: '准备、交接与历史' }).click();
  await expect(row.getByText(statement, { exact: true })).toBeVisible();
  await row.getByLabel(`准备步骤标题-${created.taskId}`, { exact: true }).fill('打印合成在读证明');
  await row.getByLabel(`开始时间-${created.taskId}`, { exact: true }).fill('2026-10-24T10:00');
  await row.getByLabel(`结束时间-${created.taskId}`, { exact: true }).fill('2026-10-24T11:00');
  expect((await clickAction(page, 'save_preparation', () => row.getByRole('button', { name: '保存准备步骤', exact: true }).click(), '/api/commands')).status()).toBe(200);
  expect((await readTask(request, created.taskId)).preparations).toEqual([expect.objectContaining({ title: '打印合成在读证明', planState: 'valid' })]);
  await row.getByLabel(`接手人别名-${created.taskId}`, { exact: true }).fill('演示同学甲');
  expect((await clickAction(page, 'request_handoff', () => row.getByRole('button', { name: '记录交接意向', exact: true }).click(), '/api/commands')).status()).toBe(200);
  const pending = await readTask(request, created.taskId);
  expect(pending.effectiveOwnerId).toBe(updated.effectiveOwnerId);
  expect(pending.handoffs).toEqual([expect.objectContaining({ toOwnerId: '演示同学甲', status: 'awaiting_confirmation' })]);
  await expect(row).toContainText('待接手（尚未联系）');
  expect((await clickAction(page, 'record_handoff_acceptance', () => row.getByRole('button', { name: '记录已接受', exact: true }).click(), '/api/commands')).status()).toBe(200);
  expect((await readTask(request, created.taskId)).effectiveOwnerId).toBe('演示同学甲');
  await expect(row).toContainText('当前负责人：演示同学甲');
  await page.screenshot({ path: 'test-results/demo-tasks-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/demo-tasks-mobile.png', fullPage: true });
});
