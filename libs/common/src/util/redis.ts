/**
 * Parse a redis:// URL into a plain options object for BullMQ's `connection`.
 * Passing options (not an ioredis instance) lets BullMQ construct its own client
 * with its bundled ioredis version, avoiding cross-version type/instance mismatches.
 */
export interface BullConnectionOptions {
  host: string;
  port: number;
  password?: string;
  db?: number;
  maxRetriesPerRequest: null;
}

export function bullConnection(url: string): BullConnectionOptions {
  const u = new URL(url);
  const db = u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : undefined;
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    password: u.password || undefined,
    db: Number.isFinite(db) ? db : undefined,
    maxRetriesPerRequest: null,
  };
}
