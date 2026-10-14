import { describe, expect, it } from 'vitest';
import { dueLabel } from '../../src/components/workspace-helpers';

describe('workspace deadline display', () => {
  it('does not claim an unspecified candidate boundary includes the date', () => {
    expect(dueLabel({ kind: 'date', date: '2026-10-20', timezone: 'Asia/Shanghai', boundary: 'unspecified', raw: '2026-10-20 17:00' }))
      .toBe('2026-10-20 · 截止边界待确认');
  });

  it('does not invent an inclusive boundary when the field is absent', () => {
    expect(dueLabel({ kind: 'date', date: '2026-10-20', timezone: 'Asia/Shanghai' }))
      .toBe('2026-10-20 · 截止边界待确认');
  });

  it.each([
    ['inclusive', '含当日'],
    ['exclusive', '当日之前'],
  ])('preserves the explicit %s boundary for candidate and task dates', (boundary, label) => {
    expect(dueLabel({ kind: 'date', date: '2026-10-20', boundary })).toBe(`2026-10-20 · ${label}`);
    expect(dueLabel({ kind: 'date', value: '2026-10-20', boundary })).toBe(`2026-10-20 · ${label}`);
  });

  it.each(['at', 'value'])('preserves the explicit instant in the %s field', (field) => {
    expect(dueLabel({ kind: 'instant', [field]: '2026-10-20T17:00:00+08:00', timezone: 'Asia/Shanghai' }))
      .toBe('2026/10/20 17:00:00（北京时间）');
  });

  it.each([null, undefined, { kind: 'unknown', raw: '另行通知' }])('preserves unknown deadlines (%j)', (value) => {
    expect(dueLabel(value)).toBe('截止日期待确认');
  });
});
