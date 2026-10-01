# Lead the owner's screen with cash

A Pakistani private-school owner's home dashboard should answer three questions in order: **how much money came in, who still owes money, and did students and staff show up today.** Everything else belongs one tap deeper. The South Asian ERPs that document an owner view converge on this set. Of 10 regional vendors with usable detail, **8 show fee collected and 7 show pending dues or defaulters**. Student attendance appears in 5, and staff attendance and income-vs-expense in 3 each. Western SIS products lead with enrollment and attendance and push finance into separate modules. So an integrated screen that puts fee receivables, attendance and approvals together is both what this market expects and a gap in the global products. The design authorities (Stephen Few, Nielsen Norman Group, Tufte) agree on the form. Keep it to a single glanceable screen with a handful of KPIs. Give every number context (target, prior period, status). Use bars and lines rather than pies and gauges, cut decoration, and pair colour with words or icons. For a non-technical owner, that becomes a short plain-language summary sentence, 4–6 KPI cards, a capped "needs attention" list linked to fixes, one trend chart, and lakh-formatted rupee figures, all stacked for a phone. One caveat applies throughout: the vendor evidence comes mostly from marketing pages, not verified screenshots. The popular "5-second rule" and "5–9 KPIs" are practitioner heuristics without primary research behind them.

## Eight of ten regional vendors put fee collection first

The Pakistani and Indian products are consistent about what an owner sees. **EDUBase Cloud (Pakistan)** says the owner "sees today's P&L, attendance, collections and defaulters". Its Owner's app adds income, expense, monthly net, a campus switcher, and approvals for salary changes and leave ([EDUBase](https://edubaseems.com/)). **PakEduSystem** mocks up tiles such as "Total Collected (Nov): Rs. 2,450,000" and "Class 10-A Collection 94% Paid". It pairs them with a recent-payments feed, a live defaulter dashboard and one-click WhatsApp defaulter alerts ([PakEduSystem](https://pakedusystem.pk/fee-management-software)). **Daftari** shows paid vs unpaid students, this month's total, outstanding dues by class, and an owner-only approval step for payments the accountant has verified ([Daftari](https://www.daftari.pk/)). India's **FastFee** shows "total collected, total pending, and today's recovery targets" with a daily defaulter priority list ([FastFee](https://fastfee.in/school-fees-app)). **SchoolLog's** director app has daily collection, student and teacher attendance, income/expense, concessions and staff leave ([SchoolLog](https://schoollog.in/)). **Fedena** has the most concrete documented layout. It has four modules: attendance (active students, absentees, staff present and on leave), fees (a collected-fees graph with 7-day/30-day/3-month/financial-year filters plus a payment-mode breakdown), income vs expense, and admissions by enquiry stage ([Fedena](https://support.fedena.com/support/solutions/articles/253146-admin-reports-analytics-and-reports-)). **Entab's** principal app adds school strength, payroll, circulars and teacher/parent login history ([Entab](https://www.entab.in/mobile-apps.html)).

The international incumbents show a different picture. **PowerSchool's** default school widgets are enrollment trend, membership trend, program enrollments and in-session days, in a grid that users add to or remove from. Richer KPIs live in the separately sold Unified Insights ([PowerSchool docs](https://ps.powerschool-docs.com/pssis-admin/latest/dashboard); [Analytics & Insights](https://www.powerschool.com/products/analytics-and-insights/)). **Edsby's** principal home is a vertical feed: News River, groups, calendar, recent activity, usage dashboards ([Edsby](https://www.edsby.com/help/principal-and-senior-administrator-quickstart/)). **openSIS** shows calendar events, notes and alerts for teachers with missing attendance ([openSIS](https://github.com/OS4ED/openSIS-Responsive-Design/blob/master/Help.php)). **Toddle's** Attendance Insights leads with three KPIs: enrolled, average presence %, and chronically absent students (below 90% presence) ([Toddle](https://help.toddleapp.com/en/articles/11142148-how-can-i-gain-insights-into-my-school-s-attendance-as-an-administrator)). **SchoolMint** adds an admissions conversion funnel ([SchoolMint](https://schoolmint6.zendesk.com/hc/en-us/articles/115001128886-Manage-Application-Dashboard-Conversion-Funnel-View)). Finance shows up only in tuition products such as Blackbaud Tuition Management, and even that evidence comes from an aggregator ([SpotSaaS](https://www.spotsaas.com/blog/blackbaud-tuition-management-review)).

The combined tally below counts each product once where its cited source mentions the widget. It measures what vendors advertise, not verified UI. Gated help centres (Veracross, Blackbaud K-12) are likely undercounted.

| Widget | South Asia (of 10) | International (of 11) | Combined |
|---|---|---|---|
| Fee collected (today / month) | 8 | 1 (tuition product) | 9 |
| Pending dues / defaulters / delinquency | 7 | 1 | 8 |
| Student attendance / chronic absence | 5 | 6 | 11 |
| Enrollment / student strength | 2 | 6 | 8 |
| Alerts / at-risk flags | 1 (Skoo default prediction) | 5 | 6 |
| Income vs expense / P&L | 3 | 0 | 3 |
| Staff attendance / on leave | 3 | 0 | 3 |
| Class-wise collection % | 3 | 0 | 3 |
| Admissions / enquiry funnel | 2 | 2 | 4 |
| Calendar / events | 0 | 4 | 4 |
| Pending approvals (leave, salary, payments) | 2 | 0 | 2 |
| Grades / behaviour | 0 | 4 / 3 | — |
| SMS balance, birthdays | 0 | 0 | 0 |

The regional products define the market's expectation. Owners there run schools as cash businesses: one Pakistani guide calls fee defaulters "the hardest part of running a school in Pakistan". It recommends an arrears list by the 11th–12th of each month, daily collection reconciled against cash deposits, and offline resilience during load-shedding ([Timeline Digi](https://timelinedigi.com/blog/school-fee-management-pakistan-guide)). Two owner-specific features separate an owner view from a clerk's: approval queues and separation of duties, where the accountant cannot edit fee structures ([Daftari](https://www.daftari.pk/)), and multi-campus switching ([EDUBase](https://edubaseems.com/)). No product found, regional or global, offers one unified "needs attention" inbox covering leave, fee waivers and admissions decisions. That is open ground.

## One screen, few numbers, every number with context

The authorities agree on four points. First, **fit the dashboard on a single screen that can be read at a glance.** NN/G says operational and analytical dashboards alike need an "at-a-glance, single-screen view" ([NN/G](https://www.nngroup.com/articles/dashboards-preattentive/)). Few lists spilling beyond one screen, and fragmenting information that should be seen together, among his 13 common pitfalls ([Few](https://www.perceptualedge.com/articles/Whitepapers/Common_Pitfalls.pdf)). Second, **encode quantities with length and position.** NN/G says to prefer bars and lines because they are processed preattentively. It says to avoid pies "most of the time", treats donuts as worse, and says gauges "consume a lot of precious space" ([NN/G](https://www.nngroup.com/articles/dashboards-preattentive/)). Third, **strip non-data ink.** This is Tufte's data-ink ratio, which counts chartjunk as ink "that does not tell the viewer anything new" ([Tufte](https://en.wikipedia.org/wiki/Edward_Tufte); [NN/G](https://www.nngroup.com/articles/clutter-charts/)). Fourth, **never show a number without context.** Few built the bullet graph for exactly this: one featured measure against a target and qualitative ranges, in a small linear strip that replaces the gauge ([Bullet graph spec](https://www.perceptualedge.com/articles/misc/Bullet_Graph_Design_Spec.pdf)). His sparklines, adopted from Tufte, add history at word size ([Few](https://www.perceptualedge.com/articles/visual_business_intelligence/best_practices_for_scaling_sparklines.pdf)).

Ordering follows importance. Material Design says to create a focal point through colour, position, size and weight, ordered by the questions users ask ([Material](https://m2.material.io/design/communication/data-visualization.html)). Polaris says each visualisation should answer one question ([Polaris](https://polaris.shopify.com/foundations/design/data-visualizations)). Practitioners add more specific rules. The viewer should grasp the main KPI, whether it is good or bad, and whether to act within about five seconds. The primary view should hold **5–9 KPIs**, with the most critical top-left, trends in the middle and detail below ([Customer Science](https://customerscience.com.au/customer-experience-2/designing-actionable-dashboards-the-5-second-rule-for-executives/); [Domo](https://www.domo.com/learn/article/what-should-be-on-an-executive-dashboard)). Treat these as testable heuristics, not laws. The 5–9 range appears to be borrowed loosely from Miller's 7±2. The products themselves, though, cluster at **3–6 visible tiles**, and for a non-technical owner the lower end is safer. The five-second test itself costs little and is the right validation: show a real owner the screen for five seconds, then ask what they saw and what they would do.

Action orientation depends on restraint. NN/G warns that too many alerts produce **alert fatigue**, where users stop reading them ([NN/G](https://www.nngroup.com/videos/alert-fatigue-user-interfaces/)). Its first heuristic, visibility of system status, argues for telling the user plainly what state things are in ([NN/G](https://www.nngroup.com/articles/visibility-system-status/)). Evaluations of public-health dashboards found them more actionable when they gave clear purpose, context and comparisons ([PMC7906125](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7906125/)). The practical form for an owner is a ranked "Needs attention" list capped at about five items, each linked straight to the fix, with "see all" below. It sits under a one-sentence plain-language summary such as "You collected Rs 1.2 lakh today, 64% of this month's target; 38 families are overdue." No authoritative study covers natural-language summaries for low-data-literacy users specifically. The recommendation rests on the context and system-status principles above and should be tested with owners.

## Colour, numbers and empty days carry the trust

Status colour follows convention: red for error, amber for warning, green or blue for success ([NN/G](https://www.nngroup.com/articles/indicators-validations-notifications/)). Never rely on colour alone. Pair it with an icon or a word, check contrast, and test palettes for colour blindness ([NN/G](https://www.nngroup.com/articles/indicators-validations-notifications/); [Atlassian](https://www.atlassian.com/data/charts/how-to-choose-colors-data-visualization)). Two rules follow for a fee dashboard. "Pending" is amber or neutral, never green, and green is reserved for paid or on target. A rising defaulter count should read "Overdue" in text, not only turn red.

Number formatting carries weight in this market. South Asian grouping runs 3-then-2 (1,00,000 is one lakh; 1,00,00,000 is one crore). `Intl.NumberFormat('en-IN')` produces 12,34,567.89, and its compact notation produces roughly "12L" ([Indian numbering](https://en.wikipedia.org/wiki/Indian_numbering_system); [localization.guide](https://www.localization.guide/country/in)). Few counts excessive precision as a pitfall ([Few](https://www.perceptualedge.com/articles/Whitepapers/Common_Pitfalls.pdf)). So cards should show compact figures such as "Rs 6.75 lakh", with the exact figure in the drill-down. One point remains unverified: whether `en-PK` produces the same compact output. Check it in target browsers, or format explicitly with en-IN grouping and a "Rs" prefix.

Empty and closed-day states decide whether owners trust the system. NN/G notes that a blank screen leaves users unsure whether anything works. Empty states should communicate status, teach, and offer a path to the next task ([NN/G](https://www.nngroup.com/articles/empty-state-interface-design/)). A Sunday or holiday should therefore say "School closed today (Sunday) — showing Friday", not display zero attendance in red. A new tenant with no fee data should show a setup prompt, not an empty chart. For loading, skeleton screens that mirror the final layout reduce perceived wait on full-page loads, and spinners suit smaller waits ([NN/G](https://www.nngroup.com/articles/skeleton-screens/); [Carbon](https://carbondesignsystem.com/patterns/loading-pattern/)). Each card should also load and fail on its own, so one slow query does not blank the whole screen.

## A vertical stack beats a customisable grid for this owner

On mobile, the one-screen ideal becomes a **prioritised vertical stack**. NN/G notes that phones show only a fraction of a table, often about two columns, and legibility without zooming is mandatory ([NN/G](https://www.nngroup.com/articles/mobile-tables/)). Progressive disclosure keeps complex applications usable ([NN/G](https://www.nngroup.com/articles/complex-application-design/)). Put extra metrics in drill-downs ([Domo](https://www.domo.com/learn/article/what-should-be-on-an-executive-dashboard)). Regional vendors confirm that owners live on phones: Entab, SchoolLog and EDUBase each ship a dedicated principal, director or owner app, and PakEduSystem and SchoolLog push payment and daily-collection updates ([Entab](https://www.entab.in/mobile-apps.html); [SchoolLog](https://schoollog.in/); [PakEduSystem](https://pakedusystem.pk/fee-management-software)).

The pattern that works reads top to bottom:

1. A greeting, the date and the open/closed status.
2. A one-sentence summary.
3. 4–6 KPI cards, each with a value, a delta against the same period last time, and a target bar or sparkline.
4. The capped "Needs attention" list.
5. One collection trend chart, as a bar or line.
6. "View details" links.

DOM order should match this priority so the desktop grid collapses into the same order on a phone. Each whole card should be a large tap target that drills down, and lists should replace tables on the home screen. PowerSchool's add/remove widget grid and Blackbaud's dashboard builder suit data teams, not a non-technical owner. A fixed, opinionated default is the better choice, with customisation at most limited to hiding cards.

The anti-patterns are equally consistent across sources:

- pies, donuts, gauges and 3D charts ([NN/G](https://www.nngroup.com/articles/dashboards-preattentive/))
- decorative banners and chartjunk ([NN/G](https://www.nngroup.com/articles/clutter-charts/))
- many small charts that each need decoding, or information split across screens ([Few](https://www.perceptualedge.com/articles/Whitepapers/Common_Pitfalls.pdf))
- bare numbers without comparison or target
- status shown by colour alone
- zeros on closed days
- unlimited red alert lists
- vanity counts such as "total students ever registered" in the prime top-left slot

## Ranked widgets and design guidance for the home screen

The ranking below weighs regional frequency and stated owner pain above international norms and design principles. The first five belong above the fold on a phone.

| Rank | Widget | What it shows and how |
|---|---|---|
| 1 | **Fee collected — this month vs expected** | Rs figure in lakh, bullet or progress bar against the month's expected dues, delta vs same point last month, today's collection as a sub-line |
| 2 | **Outstanding dues and defaulters** | Overdue family count and amount in amber/red with the word "Overdue", linking to a class-sorted defaulter list with one-tap WhatsApp/SMS reminders |
| 3 | **Needs attention** (max ~5, ranked) | Pending approvals (leave, fee waivers/concessions, salary changes, verified payments), classes with unmarked attendance, reconciliation mismatches; each item links to its fix |
| 4 | **Student attendance today** | Present % with absent count, delta vs typical day; closed-day message on holidays |
| 5 | **Staff present today** | Present / on leave / absent count; on-leave list on tap |
| 6 | **Collection trend** | One bar chart of daily or monthly collection for the current vs previous period |
| 7 | **Income vs expense (month)** | Net figure with simple two-bar comparison; drill to P&L |
| 8 | **Class-wise collection %** | Horizontal bars sorted worst-first, on the fees drill-down or below the fold |
| 9 | **Student strength and admissions** | Enrolled count with change vs last term; enquiry to admission counts during admission season |
| 10 | **Campus switcher** | For multi-campus owners, at the top rather than as a widget |

Apply these rules as acceptance criteria:

- Lead with a plain-language summary sentence.
- Show no more than six KPI cards before the attention list.
- Give every number a comparison or a target.
- Format rupees in lakh/crore grouping with compact cards and exact drill-downs.
- Use bars, lines and bullet graphs only.
- Pair every status colour with a word or icon.
- Keep pending amber and green for done.
- Show an explicit closed-day state and a teach-and-act empty state.
- Use per-card skeleton loading.
- Order the DOM by priority so the mobile stack reads correctly.

The widget ranking is an inference from vendor marketing and design principles, not from observed owner behaviour. Confirm it with five-second tests and short interviews with three to five real Pakistani school owners before locking it in.

## Conclusion

The central finding is that the right owner dashboard for this market is not a smaller version of an international SIS dashboard. It is closer to a shop owner's till summary with an inbox attached. Global products treat finance as a separate module and leaders' homes as news feeds. Pakistani owners judge software by whether it tells them, truthfully and on their phone, how much cash came in and who has not paid. That is why the ranking places the fee-vs-target card and the defaulter list above attendance, and why reconciliation and approval items belong in the attention list: the owner's trust in the numbers is itself a feature.

The clearest differentiation opportunity is the one no researched product documents: a single ranked "needs attention" queue that merges approvals, defaulters and data-quality gaps, with each item resolvable in one or two taps. That also answers alert fatigue better than colour ever can. Owners see only what needs a decision today, in words they already use and in lakh rather than millions.
