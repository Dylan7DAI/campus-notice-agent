export function assertAcyclic(edges: Record<string,string[]>): true { const visiting=new Set<string>(), done=new Set<string>(); const visit=(n:string)=>{ if(visiting.has(n)) throw new Error('PREPARATION_DEPENDENCY_CYCLE'); if(done.has(n)) return; visiting.add(n); for(const d of edges[n]??[]) visit(d); visiting.delete(n); done.add(n); }; Object.keys(edges).forEach(visit); return true; }

type DueValue = { kind?: string; value?: string; timezone?: string; boundary?: string };

function localDate(instant: string, timezone: string): string | null {
  const time = Date.parse(instant);
  if (!Number.isFinite(time)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(time));
    const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return typeof values.year === 'string' && typeof values.month === 'string' && typeof values.day === 'string'
      ? `${values.year}-${values.month}-${values.day}`
      : null;
  } catch {
    return null;
  }
}

/** Determine whether a saved preparation still fits the current due value. */
export function preparationPlanState(dueJson: string | null, end: string | null | undefined): 'valid' | 'needs_review' {
  if (!dueJson || !end) return 'needs_review';
  try {
    const due = JSON.parse(dueJson) as DueValue;
    if (due.kind === 'instant' && typeof due.value === 'string') {
      const deadline = Date.parse(due.value);
      const endAt = Date.parse(end);
      return Number.isFinite(deadline) && Number.isFinite(endAt) && endAt <= deadline ? 'valid' : 'needs_review';
    }
    if (due.kind === 'date' && typeof due.value === 'string' && typeof due.timezone === 'string') {
      const endDate = localDate(end, due.timezone);
      if (!endDate) return 'needs_review';
      return due.boundary === 'exclusive'
        ? endDate < due.value ? 'valid' : 'needs_review'
        : due.boundary === 'inclusive'
          ? endDate <= due.value ? 'valid' : 'needs_review'
          : 'needs_review';
    }
  } catch {
    return 'needs_review';
  }
  return 'needs_review';
}
