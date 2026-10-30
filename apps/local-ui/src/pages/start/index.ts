// W4-WIZARD: Get started (W4 UX v2 layer 1). The steps render inside the first-run page (the router
// maps every `/start/<step>` to it); Home (U3) places the card; main.tsx runs the open-on-launch check.
export { GetStartedCard, CARD_HIDDEN_KEY, type GetStartedCardProps } from './get-started-card.js';
export { openStartIfIncomplete, skipToHome, shouldOpenStart, START_FIRST_STEP } from './guard.js';
export {
  readSetupState,
  setupIncomplete,
  startProgress,
  type SetupState,
  type Progress,
} from './setup-state.js';
