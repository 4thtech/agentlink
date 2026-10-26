// The price of one proof (M1-11c-a4; 12 §2): the chain package's published NOTARIZE fee, one
// notarized record with up to 3 receipts. Readers (the local UI's "proofs left" and price line) take
// it from here so they never drift from the schedule the deploy config is checked against.
import { FEE_SCHEDULE_USD_MICROS } from '@4thtech-io/chain';

/** One proof, in micro-dollars (USD × 10^6). */
export const PROOF_PRICE_USD_MICROS: bigint = FEE_SCHEDULE_USD_MICROS.NOTARIZE.fee;
