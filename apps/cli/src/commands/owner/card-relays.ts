// M1-8h: the relay list an agent's first card commits to (04 §2.4 `relaysHash`; 07 §4.2, §4.3: an
// own list holds 2 to 8 relays, 3 to 5 by default).
//
// M1-18 (D-75): this is now the release's default relay set, one list in `@4thtech-io/transport-nostr`
// (`DEFAULT_RELAYS`); the old name stays so callers and tests keep working. Changing an agent's list
// later is a relay change (M1-7j, M1b).
import { DEFAULT_RELAYS } from '@4thtech-io/transport-nostr';

export const PROVISIONAL_CARD_RELAYS: readonly string[] = DEFAULT_RELAYS;
