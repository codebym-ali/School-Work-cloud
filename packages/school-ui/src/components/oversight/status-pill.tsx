import type { ReactNode } from 'react';
import { Icon, type IconName } from '@sw/ui';

/**
 * The ONE status language for owner screens (Owner UX plan, Phase 1a / principle 6): green = good (present,
 * paid, active), red = needs action (absent, overdue), amber = partial (late, part-paid), blue = informative
 * (on leave), grey = no data yet (not marked, pending). Always paired with an icon + the word — never colour
 * alone, so it survives colour-blindness and a projector in a bright staff room.
 */
export type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'neutral';

const TONE_ICON: Record<Tone, IconName> = {
  ok: 'check-circle',
  bad: 'x-circle',
  warn: 'alert',
  info: 'leave',
  neutral: 'unknown',
};

export function StatusPill({ tone, children, icon = true }: { tone: Tone; children: ReactNode; icon?: boolean }) {
  return (
    <span className={`ov-pill is-${tone}`}>
      {icon && <Icon name={TONE_ICON[tone]} size={14} />}
      <span>{children}</span>
    </span>
  );
}
