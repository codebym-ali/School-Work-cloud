'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export function ChildNav({ studentId, name }: { studentId: string; name?: string }) {
  const pathname = usePathname();
  // The attendance/results/fees endpoints return only records, so those pages can't pass a
  // name — resolve it from the children list here so every tab shows the child, not "Student".
  const [resolved, setResolved] = useState<string | undefined>(name);
  useEffect(() => {
    if (name) { setResolved(name); return; }
    let active = true;
    api.parent.children()
      .then((kids) => { if (active) setResolved(kids.find((k) => k.studentId === studentId)?.fullName); })
      .catch(() => {});
    return () => { active = false; };
  }, [studentId, name]);
  const base = `/parent/${studentId}`;
  const tabs = [
    { href: base, label: 'Overview' },
    { href: `${base}/attendance`, label: 'Attendance' },
    { href: `${base}/results`, label: 'Results' },
    { href: `${base}/fees`, label: 'Fees' },
    { href: `${base}/leaves`, label: 'Leaves' },
  ];
  return (
    <div className="stack">
      <div className="row">
        <h1>{resolved ?? 'Student'}</h1>
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
