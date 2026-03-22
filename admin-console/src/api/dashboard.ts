import { api } from './client';

export interface DashboardData {
  tenants: number;
  active: number;
  reqs: number;
  tokens: number;
  cost_today: number;
  pending: number;
  violations: number;
  skills_total: number;
}

export interface AuditEvent {
  ts: string;
  tid: string;
  ev: string;
  tool: string;
  status: string;
  ms: number;
}

// ダッシュボードAPI
export const fetchDashboard = () => api.get<DashboardData>('/dashboard');
// 直近10件の監査結果を取得するAPI
export const fetchRecentAudit = () =>
  api.get<{ events: AuditEvent[] }>('/audit?limit=10');
