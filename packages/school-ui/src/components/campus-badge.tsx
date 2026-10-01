'use client';

import { useMe } from '@sw/session';

/**
 * Campus identity badge for the shell header (Campus Ops Admin plan, Phase 7).
 *
 * Campus-bound users see "{schoolName} · {campusName}"; the owner sees "{schoolName} · All campuses".
 * Renders nothing when there's only one campus (the badge would just repeat the school name).
 */
export function CampusBadge() {
  const me = useMe();
  if (!me) return null;
  const schoolName = me.schoolName ?? 'School';
  const isOwner = (me.roles ?? []).includes('OWNER_ADMIN');
  const label = isOwner ? 'All campuses' : me.campusName;
  if (!label) return null;
  return (
    <span className="campus-badge" title={isOwner ? 'You see every campus' : `Your campus: ${label}`}>
      <strong>{schoolName}</strong> · {label}
    </span>
  );
}
