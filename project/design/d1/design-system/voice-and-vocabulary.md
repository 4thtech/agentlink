# Voice and vocabulary

Trustworthy like a notary or a good bank statement; precise like a well-made instrument. Never crypto, never hype. These replacements apply to every default surface, chat result and notification. Technical terms are allowed under **Advanced**, in developer docs and in terminal output.

| Never say | Say instead |
|---|---|
| Wallet, address | Agent ID (Advanced: address) |
| Private key, seed phrase | Passkey, recovery kit, recovery code |
| Transaction, tx hash | Proof (Advanced: transaction) |
| Gas, gas fee | Nothing: it's included in the price |
| Mint, sign transaction, notarize | Add proof, Record proof ("Notarize" is OK on tight buttons) |
| Smart contract, on-chain, blockchain | Public record |
| Base, Gnosis, chain | Nothing (proof network only in Advanced and proof details) |
| USDC, USDT, token, deposit, faucet | Credits in $, Add credits, Free test credits |
| Hash | Fingerprint (Advanced only) |
| Nostr, relay | Nothing (Advanced: message network) |
| Encryption key, decrypt | "Only you and … can read this"; Open |
| Policy, harness, envelope, agent card | Rules; your AI / AI app; message; agent profile |
| MCP (outside developer contexts) | "AgentLink in your AI app", "Connect your AI" |
| Owner key, signature | "Approve with your passkey / Touch ID" |
| Keystore, `.alks` file (terminal only) | "Key file locked with an unlock code" |
| Contract, legally binding | Agreement, proof of agreement; never claim legal effect |
| Commitment (as a label) | "Accepting terms" / "Rejecting terms" |
| Verified (alone) | "Verified domain · acme.com", "Registered", "Self-declared" |
| Password (for our codes) | The code's own name: safety code, recovery code, pairing code, unlock code |

No network picker outside Advanced, ever.

## Codes

| Name | Format | Secret | Component |
|---|---|---|---|
| Safety code | `4821 0937 5512` | No, compare it | `SafetyCode` |
| Owner fingerprint | `7F3A·19C2` | No | `Fingerprint` |
| Recovery code | 24 characters in groups | Yes | `SecretDisplay` |
| Pairing code | `318 204` | Short-lived | `TextField mono` |
| Unlock code | 24 characters, terminal only | Yes | terminal copy |

Secrets are shown once with Copy, Download, Print and "I've saved it".

## Lines to reuse

- "Your AI can't approve this for you. Only you can, with your passkey."
- "Accepting commits you to these terms. Ana's agent and anyone with the proof file can see you agreed, and when."
- "AgentLink records the agreement. It doesn't move money."
- "Name chosen by its owner. Compare the safety code to be sure."
- "This proves this exact document existed and was sent at this time. It doesn't prove its content is true."
- "Checked in your browser against the public record. Your file isn't uploaded."

## Chat and terminal text

Plain text that reads well unrendered, 80 columns in terminals, commands and links on their own line, status words `OK`, `Warning`, `Problem`, no emoji, cost first. Another party's text never appears in a summary; names follow the name rule: “Marko Novak” (Self-declared).
