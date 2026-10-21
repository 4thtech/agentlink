---
'@4thtech-io/submitter': patch
---

The submitter has a Wrangler configuration for its staging (`workers.dev`) and production (`submit.agentlink.4thtech.io`) Workers and deploy smoke tests (health, a simulated notarize per chain, the faucet refusing a mainnet); deployed by CI only (M1-10c). No runtime code changed.
