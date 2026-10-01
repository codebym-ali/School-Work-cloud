# Owner/Principal Dashboards in South Asian (Pakistan/India) K-12 School ERPs

Note: I ran about 15 tool calls. Most vendor pages describe dashboards in marketing terms; exact widget layouts were rarely documented. Fedena's help doc and PakEduSystem's mock screenshot text are the most concrete sources.

## 1. What the owner/principal dashboard shows, by vendor

### Takeaway
Fee collection (today/month), pending/defaulters, and student and staff attendance appear in the owner view of almost every vendor. Income vs expense/P&L comes next. Admissions/enquiries appear mainly in the larger Indian ERPs (Fedena, MyClassboard).

### Cited Findings
- **Fedena (India):** the admin Analytics dashboard has four modules. (1) Attendance: batch count, active students, absentees; for employees: departments, total, present, on leave. (2) Fees: a "collected fees" graph with 7-day/30-day/3-month/financial-year/custom filters, plus a payment-mode breakdown graph. (3) Income: a total income vs expense chart. (4) Admissions: admissions count, filterable by enquiry stage and application status, with enquiry/applicant/admission reports. — [Fedena support](https://support.fedena.com/support/solutions/articles/253146-admin-reports-analytics-and-reports-)
- **Entab CampusCare (India, 1,200+ schools):** the principal app shows school strength, daily attendance, staff payroll, calendars, circulars/messages, "statistics", and the login history of teachers and parents. It also offers one-touch contact with parents, management and teachers. — [Entab mobile apps](https://www.entab.in/mobile-apps.html); [Entab top-10](https://www.entab.in/top-10-best-school-erp-software-in-india.html)
- **SchoolLog (India):** the director app has a Dashboard, Student Attendance, Teacher Attendance, Daily Collection, income and expense reports, a concession report, staff leave management and send-notifications. Its marketing says "daily fee collection updates directly on phone" and defaulter reports on the go. — [schoollog.in](https://schoollog.in/)
- **MyClassboard (India):** has an admission dashboard showing real-time application status, and enquiry leads land in the "MCB dashboard". Fee due alerts go out by SMS, email, WhatsApp, voice and app notification. — [MCB admissions](https://www.myclassboard.com/admission-management-software/); [MCB fee](https://www.myclassboard.com/finance/fee-management/)
- **FastFee (India fee app):** a real-time dashboard with "total collected, total pending, and today's recovery targets", a daily defaulter priority list for follow-ups, and daily/weekly/monthly collection reports with drill-down by class, section and student. — [FastFee](https://fastfee.in/school-fees-app)
- **Generic Indian ERP fee pages:** a live collection dashboard showing today's collection, pending fees and defaulters. Defaulters can be auto-blocked from hall tickets, and the defaulter report filters by class, term and fee head. — [Micron ERP](https://www.micronerp.com/features/fee-management); [FastFee top-10 blog](https://fastfee.in/blog/top-10-school-fee-management-software-india-2026)
- **EDUBase Cloud (Pakistan):** the owner/principal "sees today's P&L, attendance, collections and defaulters". The owner also approves salary changes and leave, posts announcements and oversees messages "across all campuses". The Owner's app (v5.3.0) has income, expense, monthly net, a campus switcher, fee collection and attendance review, and financial/staff reports. — [edubaseems.com](https://edubaseems.com/)
- **PakEduSystem (Pakistan):** example dashboard tiles include "Total Collected (Nov): Rs. 2,450,000" and "Class 10-A Collection 94% Paid", a feed of recent payments, a live defaulter dashboard, one-click WhatsApp defaulter alerts and real-time payment notifications. — [PakEduSystem](https://pakedusystem.pk/fee-management-software)
- **Daftari (Pakistan):** the owner sees paid vs unpaid students, total collected this month, outstanding dues by class and each student's payment history. The owner approves payments the accountant has verified and alone controls the fee structure. It is browser-based, with no dedicated app. — [daftari.pk](https://www.daftari.pk/)
- **Skoo (Pakistan):** its AI claims to flag students at risk of fee default 14 days ahead. — [skoo.pk](https://skoo.pk/)
- **XEMPAK (Pakistan):** offers defaulters-list insights. — [xempak.com](https://xempak.com/)
- **PakEducate / eSchool / Schooliee / eSkooly (Pakistan):** these offer fee balance tracking, attendance, result cards and WhatsApp. Pricing: PakEducate from PKR 1,500/month for up to 75 students; eSchool from PKR 15/student/month; Schooliee Pro PKR 2,000 and Premium PKR 4,000 per month (200-student minimum). This source is a vendor's own comparison blog. — [PakEducate blog](https://pakeducate.com/blog/best-school-management-systems-pakistan-2026/)
- **Skolaro:** has AI-powered fee reminders and multi-account settlement. I found no dashboard detail. — [Skolaro fees](https://www.skolaro.com/fee-management-system)

### Inferences
- The Pakistani products are more narrowly fee-centric than the Indian ones: Daftari, PakEduSystem and FastFee are essentially fee dashboards. The larger Indian ERPs add admissions, payroll and engagement data such as login history.
- Multi-campus switching (EDUBase) and approval queues (EDUBase, Daftari) are owner-specific features that separate an owner from an office clerk.

### Gaps
- I found no concrete dashboard content for Teachmint, Edunext, Classe365 (the docs cover only the student/teacher dashboards), NextSchool/Schoolpad, Vidyalaya, iCampus, Zambeel, Edified, SchoolCube, ClassKit or Educore. The Fee Flow/"SchoolPulse" Play listing failed to load.
- I found no source mentioning an SMS-balance widget or a birthdays widget on an owner dashboard. Collection vs target appears only as FastFee's "recovery targets".

## 2. Layout and owner mobile apps

### Takeaway
The common pattern is summary KPI cards (collected, pending, attendance), then time-filtered charts (collection trend, income vs expense, payment mode), then lists (recent payments, defaulters). Most vendors also ship a separate principal/director/owner mobile app.

### Cited Findings
- Fedena uses per-module overview count tiles plus graphs with preset period filters, and drills down to detailed reports. — [Fedena support](https://support.fedena.com/support/solutions/articles/253146-admin-reports-analytics-and-reports-)
- PakEduSystem shows a headline month-total card, per-class % paid bars and a recent-payment feed. — [PakEduSystem](https://pakedusystem.pk/fee-management-software)
- Dedicated owner/principal apps exist for Entab (principal app), SchoolLog (director app) and EDUBase (Owner's app with campus switcher). — [Entab](https://www.entab.in/mobile-apps.html); [SchoolLog](https://schoollog.in/); [EDUBase](https://edubaseems.com/)
- Push notifications: PakEduSystem sends real-time payment notifications, and SchoolLog sends daily collection updates to the phone. — [PakEduSystem](https://pakedusystem.pk/fee-management-software); [SchoolLog](https://schoollog.in/)
- Daftari is mobile-browser only, with no app. — [Daftari](https://www.daftari.pk/)

### Gaps
- I found no documented scheduled end-of-day summary push, such as "today you collected X". The closest is SchoolLog's "daily fee collection updates".

## 3. Widget frequency tally (among 10 vendors with usable detail: Fedena, Entab, SchoolLog, MyClassboard, FastFee, Micron, EDUBase, PakEduSystem, Daftari, PakEducate)

### Takeaway
Fee collected and defaulters/pending are close to universal. Attendance comes next, then income/expense.

### Cited Findings (count = vendors whose cited source mentions it; sources are in section 1)
- Fee collected (today/period/month): 8 (Fedena, SchoolLog, FastFee, Micron, EDUBase, PakEduSystem, Daftari, PakEducate)
- Outstanding/pending/defaulters: 7 (FastFee, Micron, EDUBase, PakEduSystem, Daftari, PakEducate, SchoolLog)
- Student attendance today: 5 (Fedena, Entab, SchoolLog, EDUBase, PakEducate)
- Staff attendance/on leave: 3 (Fedena, SchoolLog, EDUBase via staff reports)
- Income vs expense / P&L: 3 (Fedena, SchoolLog, EDUBase)
- Class-wise collection %: 3 (PakEduSystem, Daftari, FastFee)
- Admissions/enquiries: 2 (Fedena, MyClassboard)
- Pending approvals (leave, salary, payments): 2 (EDUBase, Daftari)
- Student strength: 2 (Entab, Fedena active-students count)
- Payment-mode breakdown: 1 (Fedena)
- Collection target/recovery target: 1 (FastFee)
- Concessions: 1 (SchoolLog)
- Multi-campus switcher: 1 (EDUBase)
- Payroll: 1 (Entab)
- Login/engagement stats: 1 (Entab)
- SMS balance, birthdays, events: 0 found

### Inferences
- The tally is based on marketing copy, not the actual UI. The counts are indicative only.

### Gaps
- There was no screenshot-level verification of the real product UIs.

## 4. What owners care about most

### Takeaway
Owners care most about cash: daily collection, defaulters and arrears. After that they want trustworthy numbers (reconciliation, stopping the accountant from changing fees), staff and student attendance, and in Pakistan, offline/load-shedding resilience, Urdu and WhatsApp.

### Cited Findings
- "Fee defaulters are the hardest part of running a school in Pakistan". Owners want "numbers you can trust at any moment". The guide recommends an arrears list by the 11th-12th of each month and daily collection reconciled against cash deposits. It says offline operation during load-shedding is critical. — [Timeline Digi guide](https://timelinedigi.com/blog/school-fee-management-pakistan-guide)
- Pakistani school priorities are fee collection, defaulter reporting, Urdu support, attendance, result formatting, parent communication and local support (vendor blog). — [PakEducate](https://pakeducate.com/blog/best-school-management-systems-pakistan-2026/)
- Separation of duties: the owner approves verified payments, and accountants cannot edit the fee structure. — [Daftari](https://www.daftari.pk/)
- Principals see live collection "from anywhere without needing to call the office". — [FastFee top-10](https://fastfee.in/blog/top-10-school-fee-management-software-india-2026)
- Recovery tools such as WhatsApp defaulter reminders are heavily marketed. — [PakEduSystem](https://pakedusystem.pk/fee-management-software); [FastFee](https://fastfee.in/school-fees-app)

### Inferences
- A good owner home screen for this market would lead with today's cash, this month's collected vs expected, and a defaulters count linked to a one-tap WhatsApp reminder. Attendance (students and staff) would come second, and P&L third.

### Gaps
- I did not reach independent user reviews (Capterra/Play Store) that confirm owner priorities. The evidence is mostly vendor marketing.
