/**
 * The origin of another door of the SAME school, derived from where the user is standing.
 *
 * ⚠️ **Why this exists: two links handed out from the owner door were broken.** Campus Hub built its
 * campus-login link, and the Admission Portal page its shareable portal link, as
 * `${window.location.origin}/…`. That was correct while every door was a path inside one app. After
 * the front-end split `packages/school-ui` renders on MORE than one door, so "this origin" is the
 * owner door — which refuses campus admins outright, and does not serve `/admission-portal` at all.
 *
 * ⚠️ **Why not the `NEXT_PUBLIC_*_URL` build variables.** They are baked in at build time and the
 * test deploy sets them to `staff.demo.<apex>` — the DEMO school. One image serves every tenant, so
 * a build-time URL sends the second school's owner to the first school's door. The school is only
 * knowable from the host the browser is actually on, which is what this reads.
 *
 * Two host shapes:
 *   prod  `owner.<school>.<apex>`  →  swap the leading door label
 *   dev   `<school>.localhost:3005` →  keep the host, swap the port (each door is its own dev server)
 */
export type Door = 'owner' | 'staff' | 'parent';

const DOOR_LABELS: readonly Door[] = ['owner', 'staff', 'parent'];

/** Local dev ports, matching each app's `next dev -p`. */
export const DEV_DOOR_PORTS: Record<Door, string> = { owner: '3005', staff: '3006', parent: '3003' };

export interface LocationLike {
  protocol: string;
  hostname: string;
  port: string;
}

export function doorOrigin(target: Door, loc: LocationLike): string {
  const labels = loc.hostname.split('.');
  const port = loc.port ? `:${loc.port}` : '';

  // Prod shape: the first label IS a door. Replace only that label, so the school and apex survive.
  if (labels.length > 1 && (DOOR_LABELS as readonly string[]).includes(labels[0])) {
    return `${loc.protocol}//${[target, ...labels.slice(1)].join('.')}${port}`;
  }

  // Dev shape: every door shares `<school>.localhost` and differs only by port. A port that is not a
  // known door port means this is not the dev layout — keep the origin rather than invent a port.
  const isDevDoorPort = (Object.values(DEV_DOOR_PORTS) as string[]).includes(loc.port);
  if (isDevDoorPort) {
    return `${loc.protocol}//${loc.hostname}:${DEV_DOOR_PORTS[target]}`;
  }
  return `${loc.protocol}//${loc.hostname}${port}`;
}
