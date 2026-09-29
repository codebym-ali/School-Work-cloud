/**
 * Owner Oversight building blocks (Owner UX Remediation Plan, Phase 1a). One vocabulary for every owner
 * area — header → KPI strip → scope bar → table → drawer — so Students, Attendance and Reports read as one
 * product. Styles live under the `ov-` prefix in owner-web and staff-web `globals.css` (kept identical).
 */
export { KpiStrip, type KpiTileSpec } from './kpi-strip';
export { ScopeBar, useScope, type Scope, type ScopeState } from './scope-bar';
export { DataTable, type Column, type ServerPaging, type ServerSort } from './data-table';
export { RowActions, type RowAction } from './row-actions';
export { DetailDrawer } from './detail-drawer';
export { StatusPill, type Tone } from './status-pill';
export { EmptyState } from './empty-state';
