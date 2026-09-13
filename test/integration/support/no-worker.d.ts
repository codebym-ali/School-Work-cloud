/**
 * Types for the worker guard, which is plain CommonJS `.js` because Jest loads it as `globalSetup`
 * before any TypeScript transform is in play.
 */
export declare function findWorkerPids(): string[];
export declare function assertNoWorker(): void;
declare const _default: typeof assertNoWorker;
export default _default;
