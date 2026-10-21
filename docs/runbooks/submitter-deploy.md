# RB-19 · Submitter and faucet deploy (owner setup)

## Purpose
Bring the submitter Worker and its testnet credits faucet (`apps/submitter`) live: staging on `workers.dev` for CI and smoke tests, production on `submit.agentlink.4thtech.io` as the testnet beta (D-88). Agents built the pipeline (`.github/workflows/deploy-submitter.yml`, M1-10c); only the owner creates and holds the keys.

## When to use
Once, before the first submitter deploy, and again when a key is rotated, a chain is added (Gnosis Chiado with M1-3j-b) or a wallet runs low. Not for the encrypted drop (`deploy-drop.yml`, M1-27b), except Part E (account-level logging check), which covers the drop too.

## Who runs it
The owner (Tali). Agents never run `wrangler secret put`, never see a key and never approve a deployment (AGENTS.md hard rules, `release-and-deployment.md` §1, §6). Parts A, C and D work in a phone browser; Part B needs a computer with a terminal.

## Preconditions
- The M1-10c PR is merged to `main`.
- `DEPLOY_FREEZE` is empty or `false`: <https://github.com/4thtech/agentlink/settings/variables/actions>.
- The GitHub Environments `staging` and `production` already hold `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the drop (M1-27b). Workers Scripts access is account-wide, and the production token already has the `4thtech.io` zone permissions a Custom Domain needs, so no new token is required.

## Steps

### OWNER SECTION (phone or browser, except Part B)

Keys are never pasted into GitHub, chat, the sync repo, the Curator or a PR. Every key is generated and piped straight into `wrangler secret put`, so it never appears on screen, in the scrollback or in the clipboard. If you ever copy a key by hand, clear the clipboard right after (macOS: `pbcopy < /dev/null`). Staging and production never share a key, and a faucet key is never a gas key (the Worker refuses that).

**Part A · Check GitHub (2 minutes, phone)**

1. Open <https://github.com/4thtech/agentlink/settings/environments/staging> (on a phone: browser menu → "Desktop site"). Check that the secret `CLOUDFLARE_API_TOKEN` and the variable `CLOUDFLARE_ACCOUNT_ID` are listed. Nothing to add.
2. Open the `production` environment from <https://github.com/4thtech/agentlink/settings/environments>. Check the same two entries. Under "Deployment protection rules", note whether "Required reviewers" is still on: if it is, every production deploy waits for your click (step 18).

**Part B · Create and store the keys (about 15 minutes, at your computer)**

3. Open a terminal in an up-to-date checkout of `main` and go to the submitter:
   ```bash
   git pull && cd apps/submitter && pnpm install
   ```
4. Log in to Cloudflare with your own account (your personal Wrangler login; never used by CI or agents):
   ```bash
   pnpm exec wrangler login
   ```
5. Define a small helper for this shell session. It creates a new wallet, prints **only its address**, pipes the private key straight into `wrangler secret put` and then forgets it:
   ```bash
   newkey() {  # usage: newkey <SECRET_NAME> <staging|production>
     local w; w="$(cast wallet new --json)" || return 1
     printf '%s address: %s\n' "$1 ($2)" "$(jq -r '.data[0].address' <<<"$w")"
     jq -r '.data[0].private_key' <<<"$w" | tr -d '\n' | pnpm exec wrangler secret put "$1" --env "$2" --config wrangler.toml
     unset w
   }
   ```
   It needs Foundry's `cast` and `jq`. After `foundryup`, open a new terminal or run `export PATH="$HOME/.foundry/bin:$PATH"`, otherwise `cast` is not found. The jq paths were verified with Foundry cast 1.8.5, where `cast wallet new --json` prints an envelope: `{"schema_version":…,"success":true,"data":[{"address":"0x…","public_key":"0x…","private_key":"0x…"}],"errors":[],"warnings":[]}`. To re-check after a Foundry upgrade, without creating a real key: `cast wallet new --json | jq -c '.data | map(keys)'` must print `[["address","private_key","public_key"]]` (that wallet is never used). If the field names differ, adjust the two jq paths. The key must be `0x` + 64 **lowercase** hex characters; `cast` prints it that way.
   If `pnpm` is not installed globally, either enable it through corepack (`corepack enable pnpm`; the root `package.json` pins the version) or replace `pnpm exec wrangler` with `npx --yes wrangler@4.149.0` (the `wrangler` devDependency in `apps/submitter/package.json`) in step 4 and in the helper.
6. **Staging gas** wallet. Write down the printed address as "staging gas" (public, needed in Part C):
   ```bash
   newkey SUBMITTER_GAS_KEY_84532 staging
   ```
   The first secret of an environment creates the Worker `agentlink-submitter-staging`. With piped input Wrangler cannot ask, and it uses its default (create). If it stops with an error about a missing Worker instead, tell the orchestrator; do not paste the key by hand.
7. **Staging faucet** wallet. Write down the address as "staging faucet":
   ```bash
   newkey SUBMITTER_FAUCET_KEY_84532 staging
   ```
8. Staging IP-bucket key (32 random bytes, base64url; no address):
   ```bash
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' | pnpm exec wrangler secret put SUBMITTER_IP_KEY --env staging --config wrangler.toml
   ```
9. **Production gas** wallet. Write down the address as "production gas". This creates `agentlink-submitter`:
   ```bash
   newkey SUBMITTER_GAS_KEY_84532 production
   ```
10. **Production faucet** wallet. Write down the address as "production faucet":
    ```bash
    newkey SUBMITTER_FAUCET_KEY_84532 production
    ```
11. Production IP-bucket key (a new one, never the staging one):
    ```bash
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' | pnpm exec wrangler secret put SUBMITTER_IP_KEY --env production --config wrangler.toml
    ```
12. Forget the helper: `unset -f newkey`. No private key was ever printed, so there is nothing to clear from the scrollback.
13. Optional: a keyed RPC provider for production (the shipped public RPCs work without it). Type or paste comma-separated `https://` URLs at the prompt (if you pasted them, clear the clipboard afterwards: `pbcopy < /dev/null`):
    ```bash
    pnpm exec wrangler secret put SUBMITTER_RPC_URLS_84532 --env production --config wrangler.toml
    ```
14. Check the names (values are never shown):
    ```bash
    pnpm exec wrangler secret list --env staging --config wrangler.toml
    pnpm exec wrangler secret list --env production --config wrangler.toml
    ```
    Each must list `SUBMITTER_IP_KEY`, `SUBMITTER_GAS_KEY_84532` and `SUBMITTER_FAUCET_KEY_84532`, and must **not** list `SUBMITTER_CHAINS` or `SUBMITTER_FAUCET_CHAINS` (those are reviewed `wrangler.toml` vars; the deploy fails if a secret shadows one).

   *Without a terminal:* a secret can also be added in the Cloudflare dashboard, <https://dash.cloudflare.com/?to=/:account/workers-and-pages> → the Worker → Settings → Variables and Secrets → Add → type **Secret**, once the Worker exists. Creating the keys still needs a computer.

**Part C · Fund the wallets on Base Sepolia (testnet, chain 84532; about 10 minutes, phone)**

All four wallets are on **Base Sepolia only**. Testnet funds have no value; keep the balances low anyway (hot keys).

15. Send testnet funds to the addresses from Part B:

    | Wallet | What | About how much | Why |
    |---|---|---|---|
    | production gas | Base Sepolia ETH | 0.05 ETH | Pays every relayed proof (about 160 000 gas per item, batched) |
    | production faucet | Base Sepolia USDC | 20 USDC or more | Each claim credits an agent $1 (1 USDC); the default daily cap is 200 claims |
    | production faucet | Base Sepolia ETH | 0.02 ETH | Gas for the faucet's own `approve` + `depositFor` per claim |
    | staging gas | Base Sepolia ETH | 0.005 ETH (optional) | The staging smoke never sends a transaction; this only serves later rehearsals |
    | staging faucet | nothing | 0 | The staging smoke never claims |

    Faucets (open in the phone browser, paste the address, pick **Base Sepolia**):
    - ETH: <https://portal.cdp.coinbase.com/products/faucet> or <https://www.alchemy.com/faucets/base-sepolia>.
    - USDC (Circle's testnet USDC, the fee token the Notary accepts): <https://faucet.circle.com/>. It gives a fixed amount per request; repeat until the faucet wallet holds the amount above.
16. Check a balance any time on <https://sepolia.basescan.org/> (search the address), or later in `https://submit.agentlink.4thtech.io/v1/health` (`gasBalance`, in wei).

**Part D · Deploy and approve (phone browser)**

17. Start the pipeline: open <https://github.com/4thtech/agentlink/actions/workflows/deploy-submitter.yml>, tap **Run workflow**, branch `main`, leave "rehearse-rollback" off, tap **Run workflow**. (A later merge that touches the submitter starts it by itself.)
18. If `production` still has a required reviewer (step 2): once `smoke-staging` is green, the run shows **"Review deployments"**. The GitHub mobile app cannot approve environment deployments, so open the run in the phone **browser** (Actions → the run, with "Desktop site" on), tap **Review deployments**, tick **production**, tap **Approve and deploy**. If the reviewer was removed (D-52), production deploys by itself.
19. When the run is green, open <https://submit.agentlink.4thtech.io/v1/health>. Expected: `"ok":true` and chain `84532` with `"available":true`.
20. After a second deploy (any later merge, or step 17 again), rehearse the rollback once for the M1-10c acceptance: step 17 with **rehearse-rollback** ticked. The job `rollback-rehearsal` rolls staging back, checks it and rolls forward.

**Part E · Account-level logging check (phone browser; OPS-PRIV-1, 07 §7, D-109)**

CI reads back each Worker's own settings after every deploy, but its narrow API tokens cannot see account- and zone-level logging. The owner checks these for every relay Worker (`agentlink-submitter`, `agentlink-submitter-staging`, `agentlink-drop`, `agentlink-drop-staging`) now (the drop is already in production), then after any change to the account's logging or analytics setup and at each milestone release (record "account logging checked" in the deploy record, `release-and-deployment.md` §5.2). Menu names are Cloudflare's. Links marked *(unverified)* were not checked against the live dashboard; if one opens the wrong place, follow the menu path next to it.

21. **Account Logpush:** menu path: account home → **Analytics & Logs** → **Logpush**. Link *(unverified)*: <https://dash.cloudflare.com/?to=/:account/logs>. No job uses the **Workers Trace Events** dataset; if one exists for another Worker, its filter must exclude the four Workers above.
22. **Zone Logpush and log exports for `4thtech.io`:** menu path: the `4thtech.io` zone → **Analytics & Logs** → **Logpush**. Link *(unverified)*: <https://dash.cloudflare.com/?to=/:account/:zone/analytics/logs> (pick `4thtech.io`). No **HTTP requests** job (or any other job that records client IPs or URLs) covers `submit.agentlink.4thtech.io` or `drop.agentlink.4thtech.io`; a job for other hostnames must filter these two out.
23. **Workers observability destinations:** menu path: **Workers & Pages** → **Observability** (destinations). Link *(unverified)*: <https://dash.cloudflare.com/?to=/:account/workers-and-pages/observability>. No export destination (OpenTelemetry or other) is set up for logs or traces of these Workers.
24. **Each Worker's settings:** <https://dash.cloudflare.com/?to=/:account/workers-and-pages> → the Worker → **Settings** → **Observability**: Workers Logs off, Traces off, Logpush off, no Tail Workers. (CI checks this too; this is the owner's spot check.)
25. **No live tailing:** never open **Real-time logs** / `wrangler tail` on these Workers, and never use the CI deploy tokens to tail (the permission comes with Workers Scripts Edit, so it cannot be withheld; the workflow tests refuse any `wrangler tail` step). Live tails store nothing but would show requests, IPs and paths to whoever watches.

Residual (04 §4): Cloudflare, as the infrastructure operator, still sees request metadata, and the zone's Security Events show the IPs of requests a WAF rule blocks (the drop's rate-limit rule). These cannot be turned off and are not logged by us.

### What CI does (for reference)

`deploy-submitter.yml` waits for green `ci-gate` and `security-gate`, bundles once without credentials, then deploys staging (`agentlink-submitter-staging` on `workers.dev`) after checking the Worker secret **names**. `smoke-staging` (no credentials) checks `/v1/health` with every chain available, a simulated notarize on each chain (a fresh agent with no credits and `maxFee` 0: the Notary's simulation reverts, nothing is sent, no gas is spent), and that the faucet refuses a mainnet chain ID. Production (`agentlink-submitter` on `submit.agentlink.4thtech.io`) then deploys the same bytes, is health-checked over HTTP, has its logging settings read back (Logpush, observability, invocation logs, traces, log and trace export destinations, Tail Workers and streaming Tail Workers all off; the drop's workflow does the same, OPS-PRIV-1), and on failure is rolled back with `wrangler rollback` and frozen (`DEPLOY_FREEZE`). The run summary holds the deploy record draft.

## Verify
- `https://submit.agentlink.4thtech.io/v1/health` answers 200 with `"ok":true` and every chain `"available":true`.
- The run summary of the green run shows the deploy record draft: version deployed, rollback target, health check `success`, logging read-back `success`.
- Part E done: no account or zone Logpush job, export destination or Tail Worker covers the relay Workers; the deploy record says "account logging checked" with the date.
- A run where a required secret is missing shows the notice `Worker secrets not set on agentlink-submitter…: <names>` and stays green without deploying.

## If it fails
- **`The live Worker settings are not all off`**: the lines after it name each failed condition (for example `failed invocation-logs-off: result.observability.logs.invocation_logs: boolean true`), with only field paths, JSON types and boolean, number or null values. `missing` means Cloudflare did not return the field; a setting reported on is a real logging finding: fix `apps/submitter/wrangler.toml` for that environment (or the dashboard setting) and redeploy. The check is `.github/scripts/worker-logging-settings.jq`, shared by the submitter and drop workflows.
- **Skipped with "Worker secrets not set"**: the notice names the missing secrets; repeat the matching Part B step, then step 17.
- **`has a Worker secret SUBMITTER_CHAINS`** (or `SUBMITTER_FAUCET_CHAINS`): `pnpm exec wrangler secret delete <name> --env <staging|production> --config wrangler.toml`, then step 17.
- **Health shows a chain `"available":false`**: its gas key is missing or malformed (must be `0x` + 64 lowercase hex), or the RPC URLs are unreachable. Create and store a new key (step 6 or 9; then fund the new address) and rerun.
- **Faucet answers `faucet_empty` or `unavailable`**: fund the faucet wallet (step 15); check that its key differs from the gas key.
- **Production failed after deploying**: CI rolled back and set `DEPLOY_FREEZE`. Read the run summary; only the owner clears the freeze ([RB-11](rollback-and-freeze.md)).
- A key leaked or is suspected: put a new one (Part B) and move the remaining funds from the old address; follow `audit-rules.md` §10.3.

## Related
- `docs/process/release-and-deployment.md` §1 (D-88), §1.1 (hostnames), §4.5 (Workers pipeline), §5 (deploy record), §6 (secrets inventory), §8 (rollback).
- `docs/foundation/07-sdk-transport-storage.md` §7 (submitter), `05-contracts-occ-v2.md` §9 (faucet), `audit-rules.md` SUB-7.
- [RB-10](deploy-and-verify.md) deploying and verifying, [RB-11](rollback-and-freeze.md) rollback and `DEPLOY_FREEZE`.
