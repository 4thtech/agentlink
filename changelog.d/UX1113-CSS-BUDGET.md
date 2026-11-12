---
section: Changed
---

- Each page's stylesheet now loads with that page, not at app start; the CSS budget measures the start-up CSS (growth within 15 KB gzipped against 0.4.0) plus a total-growth guard of 30 KB (UX1113-CSS-BUDGET, S1).
