// Shared front-end package (Front-End Instance Separation Plan). React-free primitives PLUS — since
// the Phase 3 pnpm-workspace hoists a single React to the root — the shared React components (Icon,
// Metric). Every app imports these via the `@sw/*` alias, so the console/portal/owner/staff apps share
// ONE copy instead of duplicating them.
export type { IconName } from './icon-name';
export * from './format';
export * from './student-status';
export * from './timetable';
export * from './icon';
export * from './metric';
