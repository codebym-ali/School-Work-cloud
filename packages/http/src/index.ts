/**
 * Shared HTTP primitives (Front-End Instance Separation Plan). React-free, zero deps.
 *
 * `ApiError` lives here — NOT in `@sw/api-client` — so a front-end can handle API errors without
 * pulling in the whole tenant client. The SuperAdmin console, for instance, talks only to the
 * platform API via its own `platformApi`, and needs `ApiError` but none of the tenant endpoints;
 * importing it from here keeps the console's bundle free of tenant code (the isolation goal).
 * `@sw/api-client` re-exports this so tenant code's `import { ApiError }` is unchanged.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
    public details?: unknown,
    public requestId?: string,
  ) {
    super(message);
  }
  /** Field-level validation issues from a 422 (each `issue` names its field in the text). */
  get fieldIssues(): string[] {
    return Array.isArray(this.details)
      ? (this.details as Array<{ field?: string; issue?: string }>).map((d) => d.issue ?? '').filter(Boolean)
      : [];
  }
}
