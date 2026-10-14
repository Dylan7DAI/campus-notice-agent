import type { ReactNode } from 'react';
import './globals.css';
export const metadata = { title: '通知簿 · 校园通知工作空间', description: '保存原文、确认变化、核查材料与完成记录。' };
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="zh-CN"><body>{children}</body></html>; }
