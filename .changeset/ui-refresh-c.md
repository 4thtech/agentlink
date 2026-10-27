---
'@4thtech-io/ui': patch
---

UI-REFRESH-c: progress components. ProgressBar (determinate, stepped, indeterminate), RingMeter (with countdown), Skeleton, InlineError and the useDelayedShow timing hook (nothing under 400 ms, at least 500 ms once shown). Fills move by stroke-dashoffset, loops by transform only, with still states for reduced motion. The proof chip's spinner is removed.
