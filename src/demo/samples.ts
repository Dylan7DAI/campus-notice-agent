export type DemoSampleId = 'original' | 'update' | 'unknown';

export type DemoSample = {
  id: DemoSampleId;
  label: string;
  description: string;
  title: string;
  category: 'registration';
  requirement: string;
  date: string | null;
  text: string;
};

/** Public synthetic material for the isolated local demo, never personal notices. */
export const demoSamples: Record<DemoSampleId, DemoSample> = {
  original: {
    id: 'original', label: '首次报名通知', description: '先查看证据并确认，建立一项报名任务。',
    title: '校园志愿者报名', category: 'registration', requirement: '报名表', date: '2026-10-23',
    text: '校园志愿者报名。\n报名截止为 2026-10-23，含当日。\n报名需提交报名表。\n本通知为合成演示材料。',
  },
  update: {
    id: 'update', label: '延期并新增材料', description: '选择原报名任务，预览延期与新增在读证明。',
    title: '校园志愿者报名', category: 'registration', requirement: '在读证明', date: '2026-10-26',
    text: '校园志愿者报名更新。\n同一报名事项的截止延期为 2026-10-26，含当日。\n新增提交在读证明，原报名表要求继续保留。\n本通知为合成演示材料。',
  },
  unknown: {
    id: 'unknown', label: '日期待确定', description: '保留已知材料，将截止日期标为未知。',
    title: '校园阅读活动报名', category: 'registration', requirement: '报名表', date: null,
    text: '校园阅读活动报名。\n报名截止日期尚未确定，另行通知。\n报名需提交报名表。\n本通知为合成演示材料。',
  },
};
