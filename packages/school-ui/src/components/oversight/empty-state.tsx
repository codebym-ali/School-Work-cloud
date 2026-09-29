import type { ReactNode } from 'react';
import { Icon, type IconName } from '@sw/ui';

/**
 * An empty list that explains itself and offers the next step — never a bare "No data". A director who
 * sees nothing needs to know whether the filter is too narrow or the school genuinely has none.
 */
export function EmptyState({ icon = 'inbox', title, children, action }: {
  icon?: IconName; title: string; children?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="ov-empty" role="status">
      <span className="ov-empty-ico" aria-hidden><Icon name={icon} size={22} /></span>
      <p className="ov-empty-title">{title}</p>
      {children && <p className="ov-empty-body">{children}</p>}
      {action && <div className="ov-empty-action">{action}</div>}
    </div>
  );
}
