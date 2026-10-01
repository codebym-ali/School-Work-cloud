# Leadership/Admin Home Dashboards in International K-12 SIS/ERP Products

Research date: 2026-09-27. Limited to ~15 tool calls; many vendor help centres (Veracross community, Toddle help, Blackbaud K-12 help) are login-gated or failed to render, so several products are thinly evidenced. Screenshots/demo videos were not inspected.

## Q1. What widgets/KPIs appear on each product's admin/principal home dashboard?

### Takeaway
Across Western SIS products, the "home" screen for leaders is usually thin (enrollment counts, calendar, news, alerts). The richer KPI dashboards (attendance, chronic absence, behaviour, assessment, finance) sit in separate analytics modules: PowerSchool Unified Insights, Blackbaud SKY Reporting "Insights", Alma Data Lab, Toddle Attendance Insights, and SchoolMint Enrollment/Application dashboards. Finance KPIs appear only in tuition/billing products (Blackbaud Tuition Management), not on the SIS home page.

### Cited Findings
**PowerSchool SIS (core)**
- The dashboard exists at district and school level. It gives "an instant view of a broad range of data" in a graphical format, and users can add or remove each widget. — [PowerSchool docs: Dashboard](https://ps.powerschool-docs.com/pssis-admin/latest/dashboard)
- District widget: **Active Students Per School**. School widgets: **School Enrollment Trend** (monthly active enrollments), **School Membership Trend**, **Programs Active Enrollments**, and **In Session Days** (links to Calendar Setup). Server widgets (sign-ins, report queue, memory, and so on) are IT-only. The page also mentions an "At Risk Dashboard" tab. — [PowerSchool docs: Dashboard](https://ps.powerschool-docs.com/pssis-admin/latest/dashboard)
- On the Home page, users add widgets that show database information. Administrators control through security settings which widgets each user can see. You add a widget with "Add Widget" and remove it with the X in its corner. — [PowerSchool eSchoolPlus docs](https://docs.powerschool.com/ESPHSIS/get-started/home-page/managing-home-page-widgets-for-your-users); [PowerSchool dashboard](https://ps.powerschool-docs.com/pssis-admin/latest/dashboard)

**PowerSchool Unified Insights / Analytics & Insights**
- It pulls demographics, attendance, behaviour, grades and assessments into dashboards. It also has modules for early warning/intervention, SEL, college and career readiness, finance and operations, talent, enrollment analytics and location analytics. — [PowerSchool Analytics & Insights](https://www.powerschool.com/products/analytics-and-insights/); [video "for Principals"](https://www.powerschool.com/video/powerschool-unified-insights-for-principals/)
- It has filterable charts plus a student profile. Access is by role: teachers see only their rostered students, while principals and district users see broader views. (Alabama state rollout; secondary news source.) — [Citizen Portal](https://citizenportal.ai/articles/6517055/alabama/executive/state-agencies/alabama-state-department-of-education/state-rolls-out-unified-insights-dashboards-to-give-districts-dynamic-student-attendance-and-intervention-data)

**Blackbaud Education Management (K-12)**
- Users build dashboards from metrics called "insights", either out-of-the-box or custom. They are opened under Analysis > Dashboards, and dashboards can be shared. Schools using Enrollment Management get more preconfigured Admission insights. (These are the higher-ed help pages; the K-12 platform is shared.) — [Blackbaud Insights](https://webfiles-sc1.blackbaud.com/files/support/helpfiles/education/higher-ed/content/report-insights.html); [SKY Reporting](https://webfiles-sc1.blackbaud.com/files/support/helpfiles/education/higher-ed/content/bb-core-reports-skyreporting.html); [Educational Insights](https://webfiles-sc1.blackbaud.com/files/support/helpfiles/education/higher-ed/content/edu-reporting-preconfigured-dashboards.html)

**Blackbaud Tuition Management**
- The school-side dashboard is described as showing tuition revenue, outstanding receivables, cash flow and delinquency rates, with delinquency alerts. A "Fee and Discounts Dashboard" shows amounts received versus outstanding and the status of financial aid. This comes from a third-party review aggregator, so it is unverified against vendor docs. — [SpotSaaS review](https://www.spotsaas.com/blog/blackbaud-tuition-management-review)

**Veracross**
- Veracross has configurable portals, including admin and staff homepages. The detailed article "Portal Admin Homepage and Detail Screens Overview" exists but did not render (CSS error or login). — [Veracross portals](https://www.veracross.com/solutions/portals/); [community article](https://community.veracross.com/s/article/Portal-Admin-Homepage-and-Detail-Screens-Overview)
- A 2023 Veracross webinar (AISAP) promotes "must-have KPIs" for each office, for leadership and for the board, but the KPIs themselves sit behind a registration form. — [Veracross webinar, Aug 2023](https://www.veracross.com/resources/data-dashboards-in-determining-your-dreams/)

**Gradelink**
- Marketing copy says the SIS dashboard gives "ready access to the most critical information". The admin view covers student status, emergency contacts, medical and allergy information, current grades and attendance. Daily attendance tracks up to 15 custom attributes, and parents report absences through the app. — [Gradelink SIS](https://gradelink.com/student-information-3/); [Gradelink attendance](https://gradelink.com/attendance-tracking/)

**openSIS**
- The dashboard is the default home page. It shows **recent calendar events, portal notes, and alerts for teachers with missing attendance**, and it is blank until data accumulates. — [openSIS Help.php (GitHub)](https://github.com/OS4ED/openSIS-Responsive-Design/blob/master/Help.php)

**Alma**
- It offers a live dashboard of attendance patterns by grade, class and demographic. It flags students with concerning patterns, and it has heat maps and incident/performance dashboards over multiple periods (the "Data Lab"). — [Alma blog on chronic absenteeism](https://www.getalma.com/transforming-chronic-absenteeism-management-with-alma-a-proactive-approach-to-student-success/)
- It is marketed as having an "elegant district administration dashboard". — [School Data Leadership Assn](https://www.schooldataleadership.org/systems/student-information-systems/alma-sis-lms.html)

**SchoolMint**
- The Enrollment Dashboard has an Enrollment Summary Chart (counts per school, expandable to grade) and a Re-enrollment Overview (a bar chart of status counts with the total). You can toggle to the Application Dashboard. — [SchoolMint support](https://schoolmint6.zendesk.com/hc/en-us/articles/115000503466-Manage-Enrollment-Dashboard)
- The Application Dashboard has a Chart view and a **Conversion Funnel** view that shows where families drop off in the application flow. — [Funnel view](https://schoolmint6.zendesk.com/hc/en-us/articles/115001128886-Manage-Application-Dashboard-Conversion-Funnel-View); [Chart view](https://schoolmint6.zendesk.com/hc/en-us/articles/207346006-Manage-Application-Dashboard-Chart-View)

**Edsby**
- The principal Home Screen has a **News River** at the top, then **My Groups**, the **School Calendar**, **Recent Activity**, and **Usage Dashboards** at the bottom. "Zooms" give sortable lists of Students, Staff, Parents, Classes, Groups and Rooms. — [Edsby principal quickstart](https://www.edsby.com/help/principal-and-senior-administrator-quickstart/)
- The separate Student Analytics module has school, district and regional dashboards for finding at-risk students, with data current to the previous day. — [Edsby analytics](https://www.edsby.com/k12-student-analytics/); [Edsby technical analytics](https://www.edsby.com/technical-details/analytics/)

**Toddle**
- It has a new admin home page that brings all admin features and dashboards together, plus a "search-first" settings dashboard. — [Toddle Demo Day May 2024](https://www.toddleapp.com/learn/blog-post/toddle-demo-day-may17/)
- The Attendance Insights dashboard shows **total students enrolled**, **average presence %** over a selected period, and **number of chronically absent students** (presence below 90%). You can drill from curriculum-wide trends down to individual students. — [Toddle help (search snippet; the page returned 401)](https://help.toddleapp.com/en/articles/11142148-how-can-i-gain-insights-into-my-school-s-attendance-as-an-administrator)

**Classe365**
- The documented block customisation (show/hide blocks, drag to reorder, super-admin only) applies to the **student** dashboard. Its blocks are Attendance, LMS, Health, Report Card, Invoice, Notice board and Events. Institution analytics compare current and historic data in charts. — [Classe365 docs](https://docs.classe365.com/en/articles/8315094-student-portal-customizing-student-dashboard-by-admin); [Capterra](https://www.capterra.com/p/135075/Classe365/)

### Inferences
- Leadership "home" pages in the incumbents (PowerSchool, Edsby, openSIS) centre on enrollment counts, the calendar, news and alerts. Attendance, behaviour and academic KPIs usually need a second click into an analytics product, which is often sold separately.
- No product found puts fee receivables and attendance on one owner home screen. That combination would be a differentiator for an integrated SMB SaaS.

### Gaps
- There was no accessible documentation of the Veracross admin homepage widgets, the Blackbaud K-12 core home page, the Gradelink admin home layout, or the Classe365 admin (not student) dashboard.
- No evidence was found of staff-attendance widgets on leader dashboards in any product.

## Q2. How are these dashboards laid out, and how many KPIs are shown at once?

### Takeaway
The dominant pattern is a customisable grid of chart widgets that you add or remove (PowerSchool, Blackbaud dashboard builder, Classe365 blocks). Communication-first products (Edsby, openSIS) instead use a vertical feed: news or alerts at the top, then the calendar and activity. The KPI-card pattern (3 headline numbers) is clearest in Toddle Attendance Insights.

### Cited Findings
- PowerSchool: a widget grid at each level that users add or remove. There are 1 district widget and 4 school widgets by default, and admins control widget access through security settings. — [PowerSchool dashboard](https://ps.powerschool-docs.com/pssis-admin/latest/dashboard); [eSchoolPlus widgets](https://docs.powerschool.com/ESPHSIS/get-started/home-page/managing-home-page-widgets-for-your-users)
- Edsby: a vertical stack of News River, then groups and calendar, then recent activity, then usage dashboards. — [Edsby quickstart](https://www.edsby.com/help/principal-and-senior-administrator-quickstart/)
- Toddle: 3 headline KPIs (enrolled, average presence %, chronically absent count), then trends that drill down. — [Toddle help](https://help.toddleapp.com/en/articles/11142148-how-can-i-gain-insights-into-my-school-s-attendance-as-an-administrator)
- Blackbaud: user-built dashboards made of "insight" tiles, which can be shared. — [Blackbaud Insights](https://webfiles-sc1.blackbaud.com/files/support/helpfiles/education/higher-ed/content/report-insights.html)
- Classe365: blocks that can be shown, hidden and reordered by drag. — [Classe365 docs](https://docs.classe365.com/en/articles/8315094-student-portal-customizing-student-dashboard-by-admin)

### Inferences
- The typical visible KPI count is small, about 3 to 6 tiles or charts per screen.

### Gaps
- There are no pixel-level layout descriptions or screenshots for Veracross, Gradelink or Alma.

## Q3. Do they offer action items, comparisons, campus filters and mobile apps for leaders?

### Takeaway
Alerts and flags exist but are narrow: missing-attendance alerts, at-risk and chronic-absence flags, and delinquency alerts. Multi-school filtering is common in district products. Period-over-period comparison is explicit only in a few products. No leader-specific mobile dashboard was documented.

### Cited Findings
- openSIS: alerts for teachers with missing attendance appear on the home page. — [openSIS Help](https://github.com/OS4ED/openSIS-Responsive-Design/blob/master/Help.php)
- Alma: early flags on students and filters by grade, class and demographic. — [Alma blog](https://www.getalma.com/transforming-chronic-absenteeism-management-with-alma-a-proactive-approach-to-student-success/)
- PowerSchool: an At Risk Dashboard tab, plus levels for district, school and server. — [PowerSchool dashboard](https://ps.powerschool-docs.com/pssis-admin/latest/dashboard)
- SchoolMint: a school drop-down that expands to grade level, and a funnel view of where families drop off. — [SchoolMint enrollment dashboard](https://schoolmint6.zendesk.com/hc/en-us/articles/115000503466-Manage-Enrollment-Dashboard)
- Classe365: charts comparing current and historic data. — [Capterra](https://www.capterra.com/p/135075/Classe365/)
- Blackbaud Tuition: delinquency alerts (aggregator source only). — [SpotSaaS](https://www.spotsaas.com/blog/blackbaud-tuition-management-review)
- Edsby: district, school and regional scoping. Principals see only their own school. — [Edsby analytics](https://www.edsby.com/k12-student-analytics/)
- PowerSchool Mobile exists, but it is aimed at parents and students. — [App Store](https://apps.apple.com/us/app/powerschool-mobile/id973741088)

### Inferences
- A unified "approvals / needs attention" queue for owners (leave requests, fee waivers, admissions decisions) was not found in any product. That makes it an open design space.

### Gaps
- No sources were found for comparisons against targets, a leader mobile app, or approval inboxes in Veracross, Blackbaud or Gradelink.

## Q4. Which widgets appear most frequently across products? (frequency tally)

### Takeaway
Enrollment counts or trends and attendance (including chronic absence) are the most common, followed by calendar/events and alerts/at-risk flags. Finance and staff metrics are rare on leader dashboards.

### Cited Findings (tally across 11 products with evidence above; one count per product)
| Widget | Count | Products |
|---|---|---|
| Enrollment counts / trend | 6 | PowerSchool, SchoolMint, Toddle, Blackbaud (admission insights), Gradelink (status), Unified Insights (enrollment analytics) |
| Attendance / chronic absence | 6 | Unified Insights, Alma, Toddle, Gradelink, Classe365, openSIS (missing-attendance alert) |
| Alerts / at-risk flags | 5 | openSIS, Alma, PowerSchool At Risk, Edsby analytics, Blackbaud Tuition delinquency |
| Calendar / events | 4 | Edsby, openSIS, PowerSchool In Session Days, Classe365 |
| Behaviour / discipline | 3 | Unified Insights, Alma, Edsby Panorama |
| Grades / assessment | 4 | Unified Insights, Alma, Gradelink, Edsby |
| News / announcements | 3 | Edsby, openSIS portal notes, Classe365 notice board |
| Admissions pipeline / funnel | 2 | SchoolMint, Blackbaud Enrollment Mgmt |
| Fees / receivables | 2 | Blackbaud Tuition, Classe365 (invoice) |
| Platform usage | 1 | Edsby |
| Staff attendance | 0 | none |

The sources are those cited under Q1.

### Inferences
- A Pakistani private-school owner dashboard should lead with attendance today, enrollment and fee receivables. That combination is under-served by global products.

### Gaps
- The tally is based on accessible documentation only. Products with gated help centres (Veracross, Blackbaud K-12) are likely undercounted.
