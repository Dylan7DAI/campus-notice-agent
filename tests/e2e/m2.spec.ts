import { test, expect } from '@playwright/test';
import { demoSamples } from '../../src/demo/samples';
test('M2 text intake review preview confirm and refresh', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('粘贴合成通知文本').fill(demoSamples.original.text);
  await page.getByRole('button', {name:'保存并审核文本'}).click();
  await expect(page.getByRole('heading', { name: '文本审核 · 提案预览' })).toBeVisible();
  await page.getByRole('button', {name:'确认文本无误'}).click();
  await page.getByRole('button', {name:'生成 mock 候选'}).click();
  await page.getByRole('button', { name: '预览提案' }).click();
  await expect(page.getByText('确认前，核对将要建立的任务')).toBeVisible();
  await page.getByRole('button', {name:'确认并创建任务'}).click();
  await expect(page.locator('.task-card').filter({hasText:demoSamples.original.title}).first()).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /我的任务/ }).click();
  await expect(page.locator('.task-card').filter({hasText:demoSamples.original.title}).first()).toBeVisible();
});

test('M3 preview, visible status and ICS export path', async ({ page, request }) => {
  await page.goto('/');
  await page.getByPlaceholder('粘贴合成通知文本').fill(demoSamples.unknown.text);
  await page.getByRole('button', {name:'保存并审核文本'}).click();
  await page.getByRole('button', {name:'确认文本无误'}).click();
  await page.getByRole('button', {name:'生成 mock 候选'}).click();
  await page.getByRole('button', { name: '预览提案' }).click();
  await expect(page.getByText('确认前，核对将要建立的任务')).toBeVisible();
  const confirmation = page.waitForResponse((response) => response.url().endsWith('/api/intakes')
    && response.request().method() === 'POST' && response.request().postDataJSON().action === 'confirm');
  await page.getByRole('button', {name:'确认并创建任务'}).click();
  const confirmed = await confirmation;
  expect(confirmed.status()).toBe(200);
  const created = await confirmed.json() as { caseId: string; taskId: string; stage: string };
  expect(created.stage).toBe('applied');
  expect(created.taskId).toBeTruthy();
  type ApiTask = { id: string; caseId: string; dueJson: string | null; caseVersion: number; calendarSequence: number; executionStatus: string; consistencyStatus: string };
  const readTask = async () => {
    const response = await request.get('/api/tasks');
    expect(response.status()).toBe(200);
    const { tasks } = await response.json() as { tasks: ApiTask[] };
    const ownTask = tasks.find((item) => item.id === created.taskId);
    expect(ownTask).toBeTruthy();
    return ownTask!;
  };
  const task = await readTask();
  expect(task.caseId).toBe(created.caseId);
  // This synthetic notice explicitly leaves the date unknown. Confirm a user date through the real preview/confirm API.
  expect(task.dueJson).toBeNull();
  const unknownDateExport = await request.get(`/api/tasks/${created.taskId}/calendar.ics`);
  expect(unknownDateExport.status()).toBe(422);
  const due = { kind: 'date', value: '2026-09-30', timezone: 'Asia/Shanghai', boundary: 'inclusive' };
  const operations = [{ op: 'set_due', taskId: created.taskId, value: due }];
  const payload = JSON.stringify(operations);
  const preview = await request.post('/api/proposals', { data: {
    action: 'preview', caseId: created.caseId, expectedVersion: task.caseVersion, operations, payload,
  } });
  expect(preview.status()).toBe(201);
  const { proposal } = await preview.json() as { proposal: { proposalId: string; expectedCaseVersion: number } };
  expect((await readTask()).dueJson).toBeNull();
  const applied = await request.post(`/api/proposals/${proposal.proposalId}/confirm`, { data: {
    confirmation: true, expectedCaseVersion: proposal.expectedCaseVersion,
    idempotencyKey: `e2e-due-${created.taskId}`, payload,
  } });
  expect(applied.status()).toBe(200);
  expect(await applied.json()).toMatchObject({ code: 'APPLIED', taskIds: [created.taskId], caseVersion: task.caseVersion + 1 });
  const updated = await readTask();
  expect(updated.id).toBe(created.taskId);
  expect(updated.caseId).toBe(created.caseId);
  expect(JSON.parse(updated.dueJson!)).toEqual(due);
  expect(updated.calendarSequence).toBe(task.calendarSequence + 1);
  expect(updated.executionStatus).toBe('open');
  expect(updated.consistencyStatus).toBe('clear');
  const ics = await request.get(`/api/tasks/${created.taskId}/calendar.ics`);
  expect(ics.status()).toBe(200);
  const calendar = await ics.text();
  expect(calendar).toContain(`UID:${created.taskId}@campus-notice.local`);
  expect(calendar).toContain(`SEQUENCE:${updated.calendarSequence}`);
  expect(calendar).toContain('DTSTART;VALUE=DATE:20260930');
  expect(calendar).toContain('DTEND;VALUE=DATE:20261001');
  await page.reload();
  await page.getByRole('button', { name: /我的任务/ }).click();
  const row = page.locator(`[data-task-id="${created.taskId}"]`);
  await row.getByText('准备、交接与历史', { exact: false }).click();
  await row.getByText('查看核查信息', { exact: true }).click();
  await expect(row).toContainText(`日历版本：${updated.calendarSequence}`);
  await expect(row.getByText('待办理', { exact: true })).toBeVisible();
  expect(updated.consistencyStatus).toBe('clear');

  const cancellationPreview = page.waitForResponse((response) => response.url().endsWith('/api/proposals') && response.request().method() === 'POST');
  await row.getByRole('button', { name: '预览取消' }).click();
  expect((await cancellationPreview).status()).toBe(201);
  await expect(row.getByRole('button', { name: '确认取消' })).toBeVisible();
  const cancellationApplied = page.waitForResponse((response) => response.url().includes('/api/proposals/') && response.url().endsWith('/confirm') && response.request().method() === 'POST');
  await row.getByRole('button', { name: '确认取消' }).click();
  expect((await cancellationApplied).status()).toBe(200);
  await page.reload();
  await page.getByRole('button', { name: /我的任务/ }).click();
  await expect(row.getByText('已取消', { exact: true })).toBeVisible();
  await expect(row).toContainText('旧日历导出已失效');
  const cancelledIcs = await request.get(`/api/tasks/${created.taskId}/calendar.ics`);
  expect(cancelledIcs.status()).toBe(200);
  const cancelledText = await cancelledIcs.text();
  expect(cancelledText).toContain(`SEQUENCE:${updated.calendarSequence + 1}`);
  expect(cancelledText).toContain('STATUS:CANCELLED');
  await page.reload();
  await page.getByRole('button', { name: /我的任务/ }).click();
  await expect(row).not.toContainText('旧日历导出已失效');
});
