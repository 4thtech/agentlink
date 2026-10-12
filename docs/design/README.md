# Design intake and status

The owner (Tali) designs the app in **Claude Design**, following the brief in `docs/foundation/11-claude-design-brief.md`. The design arrives in three drops (D-30; schedule in `docs/foundation/10-build-plan.md` → *Design deliveries*). **Agents check this file before any UI work.**

## Status

| Drop | Contents | Needed by | Status | Where |
|---|---|---|---|---|
| **D1** | In-chat copy sheet (11 §6.1); tokens (§11.7) and core components (§8); local settings and approvals app (§6.2, local web UI) with its states (§9); invite placeholder page. Optional, if the owner wants them early: desktop-app-ready versions of the local approval screens (approval, commitment approval, first run) | Week 3 of M1 | ⏳ pending | — |
| **D2** | Full component library (incl. terms card and terms diff); owner console (§6.3, desktop and mobile), whose screens also serve as the desktop app's dashboard (D-41); desktop app shell (§6.2: tray menu, native approval window, biometric prompt states, harness auto-setup, updates); verify (§6.4, incl. proof of agreement); invite landing (§6.5) with browser view-and-accept (D-35); onboarding (§6.6, leading with "paste this to your agent"); pay page (§6.7, separate origin, adds credits) and pricing (§6.8, public price list); J8 negotiation screens (negotiation thread with terms diff, accept with approval, proof of agreement); prototypes J1, J2, J4, J5, J8; rationale notes | Before the M1 gate | ⏳ pending | — |
| **D3** | Launch brand and marketing site for the production domain | Before M3 public launch | ⏳ pending | — |

When a drop lands, the orchestrator records it here: the date, the links or files, and the delivered or partial status. It then schedules the intake tasks from the backlog.

## Rules for agents

1. **No design yet means functional and unstyled.** Use semantic HTML, accessible markup (WCAG 2.1 AA, keyboard navigation, visible focus) and placeholder CSS variables. **Never invent a visual design**, colour scheme or brand for a surface whose drop hasn't landed.
2. **Copy.** Until the D1 copy sheet lands, user-facing strings follow the vocabulary in 11 §5 and live in externalized string files, so they can be swapped without code changes.
3. **Implementation target** (11 §11.7):
   - tokens become CSS variables plus JSON in `packages/ui`;
   - React components go in `packages/ui`;
   - fonts are self-hosted;
   - light and dark themes;
   - no external CDNs.
4. **Fidelity.** Implement the design as delivered. Any deviation, whether technical, accessibility or security (e.g. the CSP forbids something), is written up in the PR and needs the owner's OK.
5. **Intake.** The orchestrator routes design-to-code work to Sonnet, and anything touching keys, passkeys, approvals or the deposit page to Opus (S1/S2 per `docs/process/audit-rules.md`).

## How the owner delivers

Use either or both of these:
- **Claude Design links:** paste the artifact links here, or give them to the orchestrator. Agents read them with the Artifact tool.
- **Exported files:** put them in `docs/design/<drop>/`, e.g. `docs/design/d1/`, with a short `MANIFEST.md` listing what's included. This repo is public; anything that must stay private goes to `agentlink-ops`.
