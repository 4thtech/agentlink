---
'@4thtech-io/local-ui': patch
---

UX2-e2: Add credits gets a three-step tracker under the QR code and account (B-11 §23): Waiting for your funds (the waiting mark), Arrived · $X with one "Add $X to your credits" button that opens the existing confirm screen and backup code, then Adding to your credits… until the credits read shows the new value, and Added to credits · $X now. Steps move only on the existing top-up and credits reads; a failed read keeps the step ("Couldn't check. Trying again."). Checking runs every 5 s, every 15 s after 2 minutes, stops after 30 minutes with Check again, and pauses while the tab is hidden. Replaces "Waiting for your credits…" after adding credits.
