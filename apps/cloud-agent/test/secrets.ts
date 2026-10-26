// Fixed, obviously synthetic test secrets for the Miniflare projects (vitest.config.ts). Production
// reads Worker secrets that the deploy paths set in the user's own account (08 §3.2); none is ever
// committed.
/** 32 bytes of 0x5a as 64 lowercase hex: the AGENT_SEED path. */
export const TEST_AGENT_SEED = '5a'.repeat(32);
/** 32 bytes of 0xa5 as base64url: the SEED_WRAP_KEY path. */
export const TEST_SEED_WRAP_KEY = 'paWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaU';
