'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { landingPath } from '@/lib/roles';
import styles from './page.module.css';

/** Fallback per-active-student monthly rate (decision D3) until the public pricing endpoint responds.
 *  The live figure is set by a SUPER_ADMIN/BILLING operator in the vendor console (SA6d). */
const DEFAULT_RATE = 20;
const fmtPkr = (n: number) => n.toLocaleString('en-PK');
/** Public contact address shown on the marketing site. */
const CONTACT_EMAIL = 'mutaharaslam@gmail.com';

/**
 * Public marketing landing page for SchoolWorks (the apex site a prospective school owner sees).
 * The content renders immediately for logged-out visitors; a signed-in visitor is quietly redirected
 * into the app (their role's landing screen). No credential or payment capture lives here — the
 * "book a demo" CTA is a mailto and sign-in is delegated to the real auth doors.
 */
export default function Home() {
  const router = useRouter();
  const [students, setStudents] = useState(500);
  const [rate, setRate] = useState(DEFAULT_RATE);
  useEffect(() => {
    // Already signed in? Send them into the product. Logged out (401 / no tenant) → stay on the page.
    api.me().then((me) => router.replace(landingPath(me.roles))).catch(() => {});
  }, [router]);
  useEffect(() => {
    // The operator-set public list price (SA6d) — a public, unauthenticated read. Falls back to DEFAULT_RATE.
    fetch('/api/v1/platform/public/pricing')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { const n = Number(d?.pricePerStudent); if (Number.isFinite(n) && n > 0) setRate(n); })
      .catch(() => {});
  }, []);

  const DEMO = '#demo'; // all "Book a demo" CTAs scroll to the in-page request form (SA8)

  return (
    <div className={styles.page}>
      {/* Nav */}
      <header className={styles.nav}>
        <div className={`${styles.inner} ${styles.navInner}`}>
          <a className={styles.brand} href="#top"><Cap className={styles.brandMark} /> SchoolWorks</a>
          <nav className={styles.navLinks}>
            <a className={styles.navLink} href="#features">Features</a>
            <a className={styles.navLink} href="#how">How it works</a>
            <a className={styles.navLink} href="#pricing">Pricing</a>
            <a className={styles.navLink} href="#faq">FAQ</a>
            <Link className={styles.navLink} href="/login">Sign in</Link>
            <a className={styles.navCta} href={DEMO}>Book a demo</a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className={styles.hero} id="top">
        <div className={`${styles.inner} ${styles.heroCols}`}>
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>School management, built for Pakistan</span>
            <h1 className={styles.h1}>Run your whole school in <em>one place</em>.</h1>
            <p className={styles.lead}>
              SchoolWorks brings admissions, attendance, fees, exams, payroll and parent SMS together for
              private schools — across every campus, for every role, on one secure platform.
            </p>
            <div className={styles.ctas}>
              <a className={styles.ctaPrimary} href={DEMO}>Book a demo</a>
              <Link className={styles.ctaSecondary} href="/login">Sign in →</Link>
            </div>
            <div className={styles.trustline}>
              <span><i className={styles.dot} /> Multi-campus</span>
              <span><i className={styles.dot} /> Automatic parent SMS</span>
              <span><i className={styles.dot} /> Fees, exams &amp; report cards</span>
              <span><i className={styles.dot} /> Your data stays isolated</span>
            </div>
          </div>
          <HeroPreview />
        </div>
      </section>

      {/* Capability strip */}
      <div className={styles.strip}>
        <div className={`${styles.inner} ${styles.stripInner}`}>
          {['Admissions', 'Attendance', 'Fees & billing', 'Exams', 'Report cards', 'Payroll', 'Timetable', 'Parent SMS', 'Multi-campus'].map((c) => (
            <span key={c} className={styles.stripItem}>{c}</span>
          ))}
        </div>
      </div>

      {/* Features */}
      <section className={styles.section} id="features">
        <div className={styles.inner}>
          <div className={styles.sectionHead}>
            <div className={styles.sectionKicker}>Everything the office runs on</div>
            <h2 className={styles.sectionTitle}>One system, every role</h2>
            <p className={styles.sectionLead}>
              From the admission desk to the accounts room to the class register — the whole school works from the same source of truth.
            </p>
          </div>
          <div className={styles.features}>
            {FEATURES.map((f) => (
              <div key={f.title} className={styles.feature}>
                <div className={styles.featureIcon}>{f.icon}</div>
                <h3 className={styles.featureTitle}>{f.title}</h3>
                <p className={styles.featureDesc}>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className={styles.section} id="how">
        <div className={styles.inner}>
          <div className={styles.sectionHead}>
            <div className={styles.sectionKicker}>How it works</div>
            <h2 className={styles.sectionTitle}>From sign-up to your first report card</h2>
            <p className={styles.sectionLead}>Four steps from onboarding to running the whole school, day to day.</p>
          </div>
          <div className={styles.steps}>
            {STEPS.map((s) => (
              <div key={s.n} className={styles.step}>
                <div className={styles.stepTop}>
                  <span className={styles.stepIcon}>{s.icon}</span>
                  <span className={styles.stepNum}>{s.n}</span>
                </div>
                <h3 className={styles.stepTitle}>{s.title}</h3>
                <p className={styles.stepDesc}>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials (placeholder — swap TESTIMONIALS for real quotes when available) */}
      <section className={styles.section} id="testimonials">
        <div className={styles.inner}>
          <div className={styles.sectionHead}>
            <div className={styles.sectionKicker}>Testimonials</div>
            <h2 className={styles.sectionTitle}>What schools will say</h2>
            <p className={styles.sectionLead}>Placeholder — real quotes from schools using SchoolWorks will appear here as they come on board.</p>
          </div>
          <div className={styles.quotes}>
            {TESTIMONIALS.map((t) => (
              <figure key={t.role} className={styles.quoteCard}>
                <div className={styles.quoteMark} aria-hidden="true">&rdquo;</div>
                <blockquote className={styles.quoteText}>{t.quote}</blockquote>
                <figcaption className={styles.quoteWho}>
                  <span className={styles.quoteAvatar} aria-hidden="true">{t.name.charAt(0)}</span>
                  <span><span className={styles.quoteName}>{t.name}</span><br /><span className={styles.quoteRole}>{t.role}</span></span>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing — per active student, no plan fees */}
      <section className={`${styles.section} ${styles.sectionAlt}`} id="pricing">
        <div className={styles.inner}>
          <div className={styles.sectionHead}>
            <div className={styles.sectionKicker}>Pricing</div>
            <h2 className={styles.sectionTitle}>Pay per student — nothing more</h2>
            <p className={styles.sectionLead}>
              No plan fees. No per-seat licences for your staff. You pay a small amount for each active student, every month — so your cost grows only as your school does.
            </p>
          </div>

          <div className={styles.priceHero}>
            <div className={styles.priceRate}>
              <span className={styles.priceCurrency}>PKR</span>
              <span className={styles.priceNumber}>{fmtPkr(rate)}</span>
              <span className={styles.pricePer}>per active student / month</span>
            </div>
            <ul className={styles.priceIncludes}>
              <li><Check className={styles.check} /> Every feature, for every role</li>
              <li><Check className={styles.check} /> Unlimited staff &amp; parent logins</li>
              <li><Check className={styles.check} /> Multi-campus, one bill</li>
              <li><Check className={styles.check} /> You only pay for <strong>active</strong> students</li>
            </ul>
          </div>

          <div className={styles.estimator}>
            <div className={styles.estimatorHead}>
              <label htmlFor="students">Estimate your monthly cost</label>
              <span className={styles.estimatorCount}>{fmtPkr(students)} students</span>
            </div>
            <input
              id="students" className={styles.slider} type="range"
              min={50} max={6000} step={50} value={students}
              onChange={(e) => setStudents(Number(e.target.value))}
              aria-label="Number of active students"
            />
            <div className={styles.estimatorResult}>
              ≈ <strong>PKR {fmtPkr(students * rate)}</strong> <span>/ month</span>
            </div>
            <p className={styles.estimatorNote}>
              Billed monthly on your active enrolment. Fewer students next month? Your bill goes down with it.
            </p>
          </div>

          <p className={styles.pricingNote}>
            Every school gets all features — you scale on students, not tiers. <a href={DEMO}>Book a demo</a> to lock in your per-student rate.
          </p>
        </div>
      </section>

      {/* Closing CTA */}
      <section className={styles.band}>
        <div className={styles.inner}>
          <h2 className={styles.bandTitle}>Ready to run your school better?</h2>
          <p className={styles.bandLead}>See SchoolWorks with your own classes, fees and campuses. A short demo, no commitment.</p>
          <a className={styles.ctaPrimary} href={DEMO}>Book a demo</a>
        </div>
      </section>

      {/* FAQ */}
      <section className={styles.section} id="faq">
        <div className={styles.inner}>
          <div className={styles.sectionHead}>
            <div className={styles.sectionKicker}>FAQ</div>
            <h2 className={styles.sectionTitle}>Questions, answered</h2>
          </div>
          <div className={styles.faq}>
            {FAQS.map((f) => (
              <details key={f.q} className={styles.faqItem}>
                <summary className={styles.faqQ}>{f.q}<span className={styles.faqMark} aria-hidden="true" /></summary>
                <p className={styles.faqA}>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Demo request form (SA8) */}
      <section className={`${styles.section} ${styles.sectionAlt}`} id="demo">
        <div className={styles.inner}>
          <div className={styles.sectionHead}>
            <div className={styles.sectionKicker}>Get started</div>
            <h2 className={styles.sectionTitle}>Book a demo</h2>
            <p className={styles.sectionLead}>
              Tell us about your school and we&apos;ll set up a walkthrough with your own classes, fees and campuses. No commitment.
            </p>
          </div>
          <DemoForm defaultStudents={students} />
          <p className={styles.contactLine}>
            Prefer email? Write to us at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className={styles.footer}>
        <div className={`${styles.inner} ${styles.footerInner}`}>
          <span className={styles.footerBrand}><Cap className={styles.brandMark} /> SchoolWorks</span>
          <nav className={styles.footerLinks}>
            <Link href="/owner-login">Owner sign-in</Link>
            <Link href="/staff-login">Staff sign-in</Link>
            <Link href="/student-login">Student sign-in</Link>
            <a href={DEMO}>Book a demo</a>
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </nav>
          <div className={styles.footerNote}>
            © {new Date().getFullYear()} SchoolWorks — school management for private schools in Pakistan.
            {' '}Contact: <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: 'inherit' }}>{CONTACT_EMAIL}</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ── Content ─────────────────────────────────────────────────────────────── */
const FEATURES = [
  { title: 'Admissions & enrollment', desc: 'Admit students, manage the campus seat, and issue GR & registration numbers automatically.', icon: <UserPlus /> },
  { title: 'Attendance & parent SMS', desc: 'Take daily attendance and text parents automatically when a child is marked absent.', icon: <Message /> },
  { title: 'Fees & billing', desc: 'Generate invoices, take payments and issue receipts, apply discounts, and chase defaulters.', icon: <Card /> },
  { title: 'Exams & report cards', desc: 'Enter marks against your grade scales and print clean, consistent report cards.', icon: <FileText /> },
  { title: 'HR & payroll', desc: 'Keep staff records and leaves, and run monthly payroll off the attendance you already take.', icon: <Users /> },
  { title: 'Timetable & cover', desc: 'Build period grids and bell schedules, and arrange cover for absent teachers.', icon: <Calendar /> },
  { title: 'Multi-campus', desc: 'Run several campuses under one school, with a campus lens for oversight across them all.', icon: <Building /> },
  { title: 'Portals for every role', desc: 'Owners, teachers, office staff, parents and students each get their own secure sign-in.', icon: <Shield /> },
];

const STEPS = [
  { n: 1, title: 'Get set up', desc: 'We provision your school and campuses; you add classes, sections and staff — with a secure sign-in for every role.', icon: <Building /> },
  { n: 2, title: 'Admit & enroll', desc: 'Enroll students and link their guardians. Parents, teachers, office staff and students each get their own portal.', icon: <UserPlus /> },
  { n: 3, title: 'Run every day', desc: 'Take attendance (parents get an automatic SMS), generate fee invoices and receipts, and enter exam marks.', icon: <Calendar /> },
  { n: 4, title: 'Stay on top', desc: 'Owners get live dashboards across every campus, with report cards and reports whenever you need them.', icon: <FileText /> },
];

/** Placeholder testimonials — deliberately generic ("will appear here" / "Your school") so they read
 *  as a template, never as real endorsements. Replace with real quotes (and remove the placeholder note
 *  in the section above) once schools are on board. */
const TESTIMONIALS = [
  { quote: 'A short quote from a school owner about running admissions, fees and attendance in one place will appear here.', name: 'School Owner', role: 'Your school, Lahore' },
  { quote: 'A principal’s words on saving office time and keeping parents informed by SMS will go here.', name: 'Principal', role: 'Your school, Karachi' },
  { quote: 'An accountant’s note about faster fee collection and clean receipts will appear here.', name: 'Accountant', role: 'Your school, Islamabad' },
];

const FAQS = [
  { q: 'How much does SchoolWorks cost?', a: 'You pay a small amount per active student per month — no plan fees and no per-seat licences for staff. Your cost scales with your enrolment, so you only ever pay for the students you actually have. The current rate is shown in the Pricing section above.' },
  { q: 'Does it work for multiple campuses?', a: 'Yes. Run several campuses under one school, each with its own classes, staff and students, and switch between them with a campus lens for oversight — all on one bill.' },
  { q: 'How do parents get updates?', a: 'By SMS. SchoolWorks texts parents automatically — for example when a child is marked absent or a fee falls due — which is how schools here actually reach families. Your monthly SMS allowance scales with your plan.' },
  { q: 'Is our data private and secure?', a: 'Every school’s data is fully isolated from every other school, enforced at the database level. Each role signs in separately, sensitive fields such as CNICs are encrypted, and only your school can ever see your records.' },
  { q: 'Can we bring our existing students across?', a: 'Yes. Students can be bulk-imported from a spreadsheet (CSV) during onboarding, with their guardians linked — so you are not re-typing your whole register.' },
  { q: 'How do we get started?', a: 'Book a demo and we’ll walk you through it with your own classes and fees, then help you provision your school, add your staff and import your students.' },
];

/** The public demo-request form (SA8). Submits to the public, unauthenticated capture endpoint; the
 *  hidden `website` field is a honeypot the server drops. On success it swaps to a thank-you. */
function DemoForm({ defaultStudents }: { defaultStudents: number }) {
  const [f, setF] = useState({ name: '', schoolName: '', email: '', phone: '', students: String(defaultStudents), message: '', website: '' });
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const canSubmit = f.name.trim().length > 0 && /.+@.+\..+/.test(f.email) && status !== 'sending';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setStatus('sending');
    try {
      const res = await fetch('/api/v1/platform/public/demo-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: f.name.trim(),
          email: f.email.trim(),
          schoolName: f.schoolName.trim() || undefined,
          phone: f.phone.trim() || undefined,
          studentCount: f.students ? Number(f.students) : undefined,
          message: f.message.trim() || undefined,
          website: f.website || undefined,
        }),
      });
      setStatus(res.ok ? 'sent' : 'error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'sent') {
    return (
      <div className={styles.demoDone}>
        <div className={styles.demoDoneIcon}><Check /></div>
        <h3>Thanks — we&apos;ll be in touch</h3>
        <p>Your request is in. Our team will reach out shortly to set up your demo.</p>
      </div>
    );
  }

  return (
    <form className={styles.demoForm} onSubmit={submit}>
      <div className={styles.demoGrid}>
        <div className={styles.field}><label htmlFor="d-name">Your name *</label><input id="d-name" value={f.name} onChange={(e) => set('name', e.target.value)} required /></div>
        <div className={styles.field}><label htmlFor="d-school">School name</label><input id="d-school" value={f.schoolName} onChange={(e) => set('schoolName', e.target.value)} /></div>
        <div className={styles.field}><label htmlFor="d-email">Email *</label><input id="d-email" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} required /></div>
        <div className={styles.field}><label htmlFor="d-phone">Phone</label><input id="d-phone" value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="03xx-xxxxxxx" /></div>
        <div className={styles.field}><label htmlFor="d-students">Approx. students</label><input id="d-students" type="number" min={0} value={f.students} onChange={(e) => set('students', e.target.value)} /></div>
      </div>
      <div className={styles.field}><label htmlFor="d-message">Anything else? (optional)</label><textarea id="d-message" rows={3} value={f.message} onChange={(e) => set('message', e.target.value)} /></div>
      {/* Honeypot — off-screen; a real visitor never fills it, a bot does. */}
      <input className={styles.hp} tabIndex={-1} autoComplete="off" aria-hidden="true" value={f.website} onChange={(e) => set('website', e.target.value)} />
      {status === 'error' && <p className={styles.demoError}>Something went wrong. Please try again in a moment.</p>}
      <button className={styles.demoSubmit} type="submit" disabled={!canSubmit}>{status === 'sending' ? 'Sending…' : 'Request a demo'}</button>
    </form>
  );
}

/** A stylized product preview for the hero (SA — marketing). A CSS app-window mock with sample
 *  dashboard data — fills the hero visually and shows what SchoolWorks looks like. Decorative, so
 *  aria-hidden. Numbers are illustrative sample data, as on any product screenshot. */
function HeroPreview() {
  return (
    <div className={styles.preview} aria-hidden="true">
      <div className={styles.previewBar}>
        <span className={styles.previewDots}><i /><i /><i /></span>
        <span className={styles.previewUrl}>greenwood.schoolworks.pk</span>
      </div>
      <div className={styles.previewBody}>
        <div className={styles.previewTiles}>
          <div className={styles.pTile}><div className={styles.pTileVal}>1,240</div><div className={styles.pTileLbl}>Students</div></div>
          <div className={styles.pTile}><div className={styles.pTileVal}>94%</div><div className={styles.pTileLbl}>Present today</div></div>
          <div className={styles.pTile}><div className={styles.pTileVal}>PKR 2.4M</div><div className={styles.pTileLbl}>Fees this month</div></div>
        </div>
        <div className={styles.pCard}>
          <div className={styles.pCardHead}><span>Fee collections</span><span className={styles.pMuted}>last 6 months</span></div>
          <div className={styles.pChart}>
            {[52, 64, 58, 82, 71, 90].map((h, i) => (
              <span key={i} className={i === 5 ? styles.pBarPeak : styles.pBar} style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>
        <div className={styles.pRows}>
          <div className={styles.pRow}><span className={styles.pAvatar}>A</span><span className={styles.pRowText}>Attendance marked — Class 5-A</span><span className={styles.pTag}>done</span></div>
          <div className={styles.pRow}><span className={styles.pAvatar}>S</span><span className={styles.pRowText}>Fee reminder SMS — 38 parents</span><span className={styles.pTagAmber}>sent</span></div>
        </div>
      </div>
    </div>
  );
}

/* ── Icons (inline, currentColor — the app's no-emoji rule) ──────────────── */
type IconProps = { className?: string };
const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
function Cap({ className }: IconProps) { return <svg className={className} {...base}><path d="M22 10 12 5 2 10l10 5 10-5Z" /><path d="M6 12v5c0 1 2.7 2.5 6 2.5s6-1.5 6-2.5v-5" /><path d="M22 10v6" /></svg>; }
function Check({ className }: IconProps) { return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7" /></svg>; }
function UserPlus() { return <svg {...base}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></svg>; }
function Message() { return <svg {...base}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>; }
function Card() { return <svg {...base}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>; }
function FileText() { return <svg {...base}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8M8 17h6" /></svg>; }
function Users() { return <svg {...base}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>; }
function Calendar() { return <svg {...base}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>; }
function Building() { return <svg {...base}><path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 21v-4h6v4" /><path d="M9 9h.01M15 9h.01M9 13h.01M15 13h.01" /></svg>; }
function Shield() { return <svg {...base}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></svg>; }
