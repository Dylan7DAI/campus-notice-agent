export function dueLabel(value: unknown): string {
  if (!value || typeof value !== 'object') return '截止日期待确认';
  const due = value as { kind?: string; value?: string; date?: string; at?: string; boundary?: string };
  if (due.kind === 'instant') return `${new Date(due.value ?? due.at ?? '').toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）`;
  if (due.kind !== 'date') return '截止日期待确认';
  const boundaryLabel = due.boundary === 'inclusive' ? '含当日' : due.boundary === 'exclusive' ? '当日之前' : '截止边界待确认';
  return `${due.value ?? due.date} · ${boundaryLabel}`;
}
