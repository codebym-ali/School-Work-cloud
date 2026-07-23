'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function ChildNav({ studentId, name }: { studentId: string; name?: string }) {
  const pathname = usePathname();
  const base = `/parent/${studentId}`;
  const tabs = [
    { href: base, label: 'Overview' },
    { href: `${base}/attendance`, label: 'Attendance' },
    { href: `${base}/results`, label: 'Results' },
    { href: `${base}/fees`, label: 'Fees' },
  ];
  return (
    <div className="stack">
      <div className="row">
        <h1>{name ?? 'Student'}</h1>
        <Link className="ghost small" href="/parent">← All children</Link>
      </div>
      <div className="row" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        {tabs.map((t) => (
          <Link key={t.href} className={`chip ${pathname === t.href ? 'active' : ''}`} href={t.href}>{t.label}</Link>
        ))}
      </div>
    </div>
  );
}
