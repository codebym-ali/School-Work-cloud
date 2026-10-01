# Dashboard UX & Information Design for Non-Technical Executives (School Owner Home Dashboard)

## What do the authorities recommend (Few, NN/G, Tufte, Material, Carbon, Atlassian, Polaris)? 5-second rule, scanning patterns, KPI count, single screen, data-ink

### Takeaway
The core authorities agree on this: fit everything on one screen, show it at a glance, use length and position (bars, lines) rather than angles and dials (pies, gauges), cut non-data decoration, and always give numbers context. The "5-second rule" and "5–9 KPIs" come from practitioners and vendors. They are useful heuristics, but no primary research establishes them.

### Cited Findings
- Operational and analytical dashboards both need an "at-a-glance, single-screen view" of the data they monitor. Operational dashboards support time-sensitive decisions. — [NN/G, Dashboards: Preattentive](https://www.nngroup.com/articles/dashboards-preattentive/)
- Use length (bar charts) and 2D position (line charts) for quantities. The eye processes these preattentively. Colour works best as a secondary grouping cue, not for encoding quantity. — [NN/G](https://www.nngroup.com/articles/dashboards-preattentive/)
- Avoid pie charts "most of the time". Donut charts are even worse. Gauges "consume a lot of precious space" and are harder to read than linear graphs. — [NN/G](https://www.nngroup.com/articles/dashboards-preattentive/)
- Stephen Few lists 13 common pitfalls. Examples include spilling beyond a single screen, choosing a deficient measure, and splitting information into separate pieces or screens when it should be seen together. His framing: most dashboards "say too little" and need too much effort to read. — [Few, Common Pitfalls in Dashboard Design (PDF)](https://www.perceptualedge.com/articles/Whitepapers/Common_Pitfalls.pdf). The PDF text could not be machine-extracted, so the full list comes from search summaries. Other pitfalls commonly attributed to it include showing data without context, excessive detail or precision, poorly chosen charts, meaningless variety, useless decoration, and misused colour.
- Few invented the bullet graph to replace gauges and meters. It shows one featured measure plus comparison measures (target, qualitative ranges) in a small linear space. — [Bullet Graph Design Spec](https://www.perceptualedge.com/articles/misc/Bullet_Graph_Design_Spec.pdf); [Wikipedia: Bullet graph](https://en.wikipedia.org/wiki/Bullet_graph)
- Tufte's data-ink ratio is data-ink divided by total ink, and he says to maximise it. Chartjunk is "ink that does not tell the viewer anything new". — [Wikipedia: Edward Tufte](https://en.wikipedia.org/wiki/Edward_Tufte); [NN/G: Clutter-Free charts](https://www.nngroup.com/articles/clutter-charts/)
- Tufte's sparklines are small, word-sized line charts that can sit inline with text. Few adopted them for dashboards as a compact way to show history. — [Wikipedia: Edward Tufte](https://en.wikipedia.org/wiki/Edward_Tufte); [Few, scaling sparklines (PDF)](https://www.perceptualedge.com/articles/visual_business_intelligence/best_practices_for_scaling_sparklines.pdf)
- Material Design: set a focal point by prioritising information through colour, position, size and weight, ordered by the questions users ask. Layout and interaction should reflect the dashboard's purpose. — [Material Design: Data visualization](https://m2.material.io/design/communication/data-visualization.html)
- Shopify Polaris: each visualisation should answer a single question, and consistent styles and formats protect data integrity. The URL now redirects to shopify.dev, so this is from the search summary. — [Polaris data visualizations](https://polaris.shopify.com/foundations/design/data-visualizations)
- The "5-second rule": a viewer should know the main KPI, whether it is good or bad, and whether action is needed within five seconds. These sources also suggest 5–9 KPIs on the primary view, the most critical metric at top-left (F-pattern), trends in the middle, detail lower down, and more in drill-downs. The test is to show the dashboard to a newcomer for 5 seconds and ask what they saw and what they would do. — [Customer Science](https://customerscience.com.au/customer-experience-2/designing-actionable-dashboards-the-5-second-rule-for-executives/); [Domo](https://www.domo.com/learn/article/what-should-be-on-an-executive-dashboard); [Den Otter](https://denottersolutions.com/en/data-insights/dashboard-design-5-seconds-rule/). These are vendor and consultant sources, not primary research.

### Inferences
- For a school owner, put one hero status line first, then a short row of KPI cards (about 4–6), then a ranked action list, then a single trend chart. Use no pies, gauges, 3D or decorative banners.
- Show progress toward target with bullet graphs or simple horizontal progress bars.

### Gaps
- I found no primary empirical study that validates "5 seconds" or "5–9 KPIs". The 5–9 figure appears to be loosely derived from Miller's 7±2.
- Carbon's dashboard page and the current Polaris data-viz page could not be fetched. The Carbon content is not verified.

## How to make it action-oriented (needs-attention lists, ranked alerts, plain-language summaries, targets, comparisons, sparklines)

### Takeaway
Numbers need context: a comparison, a target and a status. Alerts must be sparing and use more than colour, or users tune them out.

### Cited Findings
- Showing data without context is a core Few pitfall. The bullet graph exists to pair a measure with its target and comparison ranges. — [Few spec](https://www.perceptualedge.com/articles/misc/Bullet_Graph_Design_Spec.pdf)
- Indicators draw attention to dynamic content. Implement them with icons, typographic variation (bold or colour) and size or animation, not colour alone. — [NN/G: Indicators, Validations, Notifications](https://www.nngroup.com/articles/indicators-validations-notifications/)
- NN/G warns about alert fatigue: too many alerts cause users to ignore them. — [NN/G video: Alert Fatigue](https://www.nngroup.com/videos/alert-fatigue-user-interfaces/)
- Visibility of system status (heuristic #1): keep users informed about what is going on. — [NN/G](https://www.nngroup.com/articles/visibility-system-status/)
- Studies of public-health dashboards judged them more actionable when they gave clear purpose, context and comparisons. — [PMC7906125](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7906125/); [PMC8360335](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8360335/)

### Inferences
- Use sentence-style headlines, e.g. "You collected Rs 1.2L today — 64% of this month's target; 38 families are overdue."
- Show each KPI with a delta against the same day last week or last month, plus a sparkline.
- Build a "Needs attention" list ranked by urgency, with each item linking to the fix. Cap it at about 5 and add "see all".

### Gaps
- I found no authoritative source specifically on sentence-style (NLG) summaries for non-data-literate users.

## Colour semantics, number formatting, empty/zero/closed-day, loading states

### Takeaway
Use colour sparingly and redundantly. Use locale-aware compact numbers. Design empty and loading states on purpose.

### Cited Findings
- Don't rely on colour alone. Ensure contrast. Use qualitative, sequential or diverging palettes according to the data type. Colour blindness can make charts unreadable, so adjust lightness and saturation and check with tools like Coblis or Viz Palette. — [Atlassian: Data viz colour guide](https://www.atlassian.com/data/charts/how-to-choose-colors-data-visualization); [Atlassian Design: Accessibility](https://atlassian.design/foundations/accessibility)
- Red is conventionally used for errors, orange or yellow for warnings, and green or blue for success. — [NN/G](https://www.nngroup.com/articles/indicators-validations-notifications/)
- Indian and Pakistani grouping is 3-then-2 (1,00,000 = 1 lakh; 1,00,00,000 = 1 crore). `Intl.NumberFormat('en-IN')` gives 12,34,567.89, and compact notation renders about 12L. — [Wikipedia: Indian numbering](https://en.wikipedia.org/wiki/Indian_numbering_system); [localization.guide India](https://www.localization.guide/country/in)
- Excessive precision is a Few pitfall. — [Few](https://www.perceptualedge.com/articles/Whitepapers/Common_Pitfalls.pdf)
- A blank empty state makes users unsure whether the system works. Empty states should communicate system status, aid learning, and give a direct path to key tasks. — [NN/G: Empty states](https://www.nngroup.com/articles/empty-state-interface-design/)
- Skeleton screens (grey wireframe blocks that mimic the layout) reduce perceived wait on full-page loads and let users form a mental model of the page first. Spinners and progress bars suit other cases. — [NN/G: Skeleton Screens](https://www.nngroup.com/articles/skeleton-screens/); [Carbon loading pattern](https://carbondesignsystem.com/patterns/loading-pattern/)

### Inferences
- "Pending" should be amber or neutral, not green. Reserve green for done or on target.
- Pair every status colour with an icon or word such as "Overdue".
- Use compact numbers on cards (Rs 6.75L) with the full figure in a tooltip or drill-down.
- Label a weekend or holiday explicitly, e.g. "School closed today (Sunday) — last working day: …", instead of showing 0 or red.

### Gaps
- `en-PK` compact output was not verified. Check it in the browser, and be aware it may differ from en-IN.

## Mobile-first, card stacking order, progressive disclosure/drill-down

### Takeaway
On a phone, the single-screen ideal becomes a prioritised vertical stack: status, then actions, then KPIs, then trend. Keep detail behind drill-downs.

### Cited Findings
- On small screens users see only a fraction of tables. Legibility without zoom is required, and often only about 2 columns fit. Lock headers and let users choose subsets. — [NN/G: Mobile Tables](https://www.nngroup.com/articles/mobile-tables/)
- Place additional metrics in drill-down views. — [Domo](https://www.domo.com/learn/article/what-should-be-on-an-executive-dashboard) (vendor)
- Complex-application guidelines favour progressive disclosure and reducing clutter. — [NN/G: 8 Guidelines for Complex Applications](https://www.nngroup.com/articles/complex-application-design/)

### Inferences
- DOM order should equal priority order, so the stack reads correctly on mobile.
- Replace tables with lists on the home screen, and make the whole card a large tap target that drills down.

### Gaps
- I did not find authoritative research specific to executive mobile dashboards.

## Concrete layout patterns and anti-patterns

### Takeaway
Pattern: a hero sentence, 4–6 KPI cards (value + delta + sparkline or target bar), a ranked "needs attention" list, one trend chart, and drill-down links.
Anti-patterns: many charts, pies, gauges, 3D, decorative headers, unlabeled numbers, context-free vanity metrics, and colour-only status.

### Cited Findings
- Avoid pies, donuts and gauges. Prefer bars and lines. — [NN/G](https://www.nngroup.com/articles/dashboards-preattentive/)
- Avoid chartjunk and decoration. — [Wikipedia: Tufte](https://en.wikipedia.org/wiki/Edward_Tufte); [NN/G clutter](https://www.nngroup.com/articles/clutter-charts/)
- Avoid fragmentation, deficient measures and exceeding one screen. — [Few](https://www.perceptualedge.com/articles/Whitepapers/Common_Pitfalls.pdf)
- One question per chart. — [Polaris](https://polaris.shopify.com/foundations/design/data-visualizations)
- Place the most important item top-left, following the F-pattern. — [Customer Science](https://customerscience.com.au/customer-experience-2/designing-actionable-dashboards-the-5-second-rule-for-executives/) (practitioner)

### Inferences
- A school-owner home screen should read top-down: greeting + date + open/closed status → one-sentence summary → KPI cards (fee collection vs target, today's attendance %, overdue dues, staff present) → needs-attention list → a single fee-collection trend chart → "View details" links.

### Gaps
- There is no usability evidence specific to school owners or the Pakistani market. Test with 5-second tests and real owners.
