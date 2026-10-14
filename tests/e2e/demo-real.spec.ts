import { test, expect, type Page } from '@playwright/test';

test.skip(!process.env.E2E_REAL_APP_DIR, 'Real adapter regression needs its isolated local provider harness.');

async function clickIntake(page: Page, action: string, click: () => Promise<void>) {
  const pending = page.waitForResponse((response) => response.url().endsWith('/api/intakes')
    && response.request().method() === 'POST' && response.request().postDataJSON().action === action);
  await click();
  const response = await pending;
  await expect(page.getByText('正在处理，请稍候…', { exact: true })).toBeHidden();
  return response;
}

test('real-mode UI uses local HTTP adapter for text, image and retained failure drafts', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('.mode-indicator')).toContainText('真实识别已启用');
  const text = '合成环保活动报名。\n截止2026-11-02，含当日。\n报名需提交报名表。';
  await page.locator('#notice-text').fill(text);
  expect((await clickIntake(page, 'create', () => page.getByRole('button', { name: /保存并审核文本/ }).click())).status()).toBe(200);
  expect((await clickIntake(page, 'approve', () => page.getByRole('button', { name: '确认文本无误', exact: true }).click())).status()).toBe(200);
  await expect(page.getByRole('button', { name: '提取通知事项', exact: true })).toBeVisible();
  await expect(page.getByText(/发送.*模型|模型.*发送|外传/).first()).toBeVisible();
  const extracted = await clickIntake(page, 'extract', () => page.getByRole('button', { name: '提取通知事项', exact: true }).click());
  expect(extracted.status()).toBe(200);
  expect(await extracted.json()).toMatchObject({ mode: 'real', status: 'succeeded' });
  expect((await clickIntake(page, 'preview', () => page.getByRole('button', { name: '预览提案', exact: true }).click())).status()).toBe(200);
  const beforeConfirmation = await request.get('/api/tasks');
  expect((await beforeConfirmation.json()).tasks).toHaveLength(0);
  const confirmed = await clickIntake(page, 'confirm', () => page.getByRole('button', { name: '确认并创建任务', exact: true }).click());
  expect(confirmed.status()).toBe(200);
  const created = await confirmed.json() as { taskId: string };
  await expect(page.locator(`[data-task-id="${created.taskId}"]`)).toContainText('合成环保活动报名');
  const replay = await request.post('/api/intakes', { data: confirmed.request().postDataJSON() });
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toMatchObject({ taskId: created.taskId, replayed: true });
  expect((await (await request.get('/api/tasks')).json()).tasks).toHaveLength(1);

  await page.getByRole('button', { name: /新建通知/ }).click();
  await page.getByRole('tab', { name: '上传截图', exact: true }).click();
  await page.getByLabel('通知截图', { exact: true }).setInputFiles({ name: 'synthetic-real.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mioAAAAASUVORK5CYII=', 'base64') });
  const uploading = page.waitForResponse((response) => response.url().endsWith('/api/intakes') && response.request().headers()['content-type']?.includes('multipart/form-data'));
  await page.getByRole('button', { name: '保存图片', exact: true }).click();
  expect((await uploading).status()).toBe(200);
  await expect(page.getByText('正在处理，请稍候…', { exact: true })).toBeHidden();
  expect((await clickIntake(page, 'recognize', () => page.getByRole('button', { name: '识别图片文字', exact: true }).click())).status()).toBe(200);
  await expect(page.locator('#notice-text')).toHaveValue('合成图书活动报名。\n截止2026-11-02，含当日。\n报名需提交报名表。');
  await expect(page.getByRole('button', { name: '提取通知事项', exact: true })).toBeDisabled();
  expect((await clickIntake(page, 'approve', () => page.getByRole('button', { name: '确认文本无误', exact: true }).click())).status()).toBe(200);
  expect((await clickIntake(page, 'extract', () => page.getByRole('button', { name: '提取通知事项', exact: true }).click())).status()).toBe(200);
  expect((await clickIntake(page, 'preview', () => page.getByRole('button', { name: '预览提案', exact: true }).click())).status()).toBe(200);
  expect((await clickIntake(page, 'confirm', () => page.getByRole('button', { name: '确认并创建任务', exact: true }).click())).status()).toBe(200);
  expect((await (await request.get('/api/tasks')).json()).tasks).toHaveLength(2);

  await page.getByRole('button', { name: /新建通知/ }).click();
  await page.getByRole('tab', { name: '粘贴文本', exact: true }).click();
  const failureText = 'PROVIDER_FAIL 合成报名。\n截止2026-11-02，含当日。\n报名需提交报名表。';
  await page.locator('#notice-text').fill(failureText);
  const failedDraftResponse = await clickIntake(page, 'create', () => page.getByRole('button', { name: /保存并审核文本/ }).click());
  const failedDraft = await failedDraftResponse.json() as { intakeId: string };
  expect((await clickIntake(page, 'approve', () => page.getByRole('button', { name: '确认文本无误', exact: true }).click())).status()).toBe(200);
  const failure = await clickIntake(page, 'extract', () => page.getByRole('button', { name: '提取通知事项', exact: true }).click());
  expect(failure.status()).toBe(503);
  await expect(page.locator('.notice[role="alert"]')).toContainText('草稿已保留');
  expect((await (await request.get('/api/tasks')).json()).tasks).toHaveLength(2);
  const saved = await (await request.get(`/api/intakes?id=${failedDraft.intakeId}`)).json() as { text: string; approved: boolean; candidateJson: string | null; runs: { status: string; errorCode: string }[] };
  expect(saved).toMatchObject({ text: failureText, approved: true, candidateJson: null });
  expect(saved.runs).toEqual([expect.objectContaining({ status: 'failed', errorCode: 'MODEL_UNAVAILABLE' })]);
  await page.reload();
  await expect(page.locator('#notice-text')).toHaveValue(failureText);
  await expect(page.getByRole('button', { name: '提取通知事项', exact: true })).toBeEnabled();
});
