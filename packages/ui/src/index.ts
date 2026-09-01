// Shared front-end primitives (Front-End Instance Separation Plan). Currently the REACT-FREE parts —
// a type + pure presentation/domain utils — so every app can import them via the `@sw/*` alias without
// a workspace. The react components (Icon, Metric, and later the school screens) join this package in
// Phase 3, once the pnpm-workspace foundation lets packages resolve React.
export type { IconName } from './icon-name';
export * from './format';
export * from './student-status';
export * from './timetable';
