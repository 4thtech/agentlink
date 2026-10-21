# RB-19 · Submitter and faucet deploy (owner setup)

## Purpose
Bring the submitter Worker and its testnet credits faucet (`apps/submitter`) live: staging on `workers.dev` for CI and smoke tests, production on `submit.agentlink.4thtech.io` as the testnet beta (D-88). Agents built the pipeline (`.github/workflows/deploy-submitter.yml`, M1-10c); only the owner creates and holds the keys.

## When to use
Once, before the first submitter deploy, and again when a key is rotated, a chain is added (Gnosis Chiado with M1-3j-b) or a wallet runs low. Not for the encrypted drop (`deploy-drop.yml`, M1-27b).

## Who runs it
The owner (Tali). Agents never run `wrangler secret put`, never see a key and never approve a deployment (AGENTS.md hard rules, `release-and-deployment.md` §1, §6). Parts A, C and D work in a phone browser; Part B needs a computer with a terminal.

## Preconditions
- The M1-10c PR is merged to `main`.
- `DEPLOY_FREEZE` is empty or `false`: <https://github.com/4thtech/agentlink/settings/variables/actions>.
- The GitHub Environments `staging` and `production` already hold `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the drop (M1-27b). Workers Scripts access is account-wide, and the production token already has the `4thtech.io` zone permissions a Custom Domain needs, so no new token is required.

## Steps

### OWNER SECTION (phone or browser, except Part B)

Keys are never pasted into GitHub, chat, the sync repo, the Curator or a PR. Every key goes straight from your terminal into the `wrangler secret put` prompt. Staging and production never share a key, and a faucet key is never a gas key (the Worker refuses that).

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
5. Create the **staging gas** wallet: run `cast wallet new` (Foundry). Write down the **Address** (public, needed in Part C) labelled "staging gas".
6. Store its private key:
   ```bash
   pnpm exec wrangler secret put SUBMITTER_GAS_KEY_84532 --env staging --config wrangler.toml
   ```
   Wrangler asks whether to create the Worker `agentlink-submitter-staging`: answer **yes**. Then paste the **Private key** from step 5 at the prompt (`0x` + 64 lowercase hex characters).
7. Create the **staging faucet** wallet: run `cast wallet new` again. Write down its Address as "staging faucet".
8. Store its private key:
   ```bash
   pnpm exec wrangler secret put SUBMITTER_FAUCET_KEY_84532 --env staging --config wrangler.toml
   ```
9. Store the staging IP-bucket key. Generate it and pipe it in, so it never shows on screen:
   ```bash
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' | pnpm exec wrangler secret put SUBMITTER_IP_KEY --env staging --config wrangler.toml
   ```
10. Create the **production gas** wallet with `cast wallet new`; write down its Address as "production gas". Store the key (answer **yes** to create `agentlink-submitter`):
    ```bash
    pnpm exec wrangler secret put SUBMITTER_GAS_KEY_84532 --env production --config wrangler.toml
    ```
11. Create the **production faucet** wallet with `cast wallet new`; write down its Address as "production faucet". Store the key:
    ```bash
    pnpm exec wrangler secret put SUBMITTER_FAUCET_KEY_84532 --env production --config wrangler.toml
    ```
12. Store the production IP-bucket key (a new one, never the staging one):
    ```bash
    openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' | pnpm exec wrangler secret put SUBMITTER_IP_KEY --env production --config wrangler.toml
    ```
13. Optional: a keyed RPC provider for production (the shipped public RPCs work without it). Paste comma-separated `https://` URLs at the prompt:
    ```bash
    pnpm exec wrangler secret put SUBMITTER_RPC_URLS_84532 --env production --config wrangler.toml
    ```
14. Check the names (values are never shown), then clear the terminal (`clear`, and close the window so the private keys leave the scrollback):
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

### What CI does (for reference)

`deploy-submitter.yml` waits for green `ci-gate` and `security-gate`, bundles once without credentials, then deploys staging (`agentlink-submitter-staging` on `workers.dev`) after checking the Worker secret **names**. `smoke-staging` (no credentials) checks `/v1/health` with every chain available, a simulated notarize on each chain (a fresh agent with no credits and `maxFee` 0: the Notary's simulation reverts, nothing is sent, no gas is spent), and that the faucet refuses a mainnet chain ID. Production (`agentlink-submitter` on `submit.agentlink.4thtech.io`) then deploys the same bytes, is health-checked over HTTP, has its logging settings read back, and on failure is rolled back with `wrangler rollback` and frozen (`DEPLOY_FREEZE`). The run summary holds the deploy record draft.

## Verify
- `https://submit.agentlink.4thtech.io/v1/health` answers 200 with `"ok":true` and every chain `"available":true`.
- The run summary of the green run shows the deploy record draft: version deployed, rollback target, health check `success`, logging read-back `success`.
- A run where a required secret is missing shows the notice `Worker secrets not set on agentlink-submitter…: <names>` and stays green without deploying.

## If it fails
- **Skipped with "Worker secrets not set"**: the notice names the missing secrets; repeat the matching Part B step, then step 17.
- **`has a Worker secret SUBMITTER_CHAINS`** (or `SUBMITTER_FAUCET_CHAINS`): `pnpm exec wrangler secret delete <name> --env <staging|production> --config wrangler.toml`, then step 17.
- **Health shows a chain `"available":false`**: its gas key is missing or malformed (must be `0x` + 64 lowercase hex), or the RPC URLs are unreachable. Put the key again (step 6 or 10) and rerun.
- **Faucet answers `faucet_empty` or `unavailable`**: fund the faucet wallet (step 15); check that its key differs from the gas key.
- **Production failed after deploying**: CI rolled back and set `DEPLOY_FREEZE`. Read the run summary; only the owner clears the freeze ([RB-11](rollback-and-freeze.md)).
- A key leaked or is suspected: put a new one (Part B) and move the remaining funds from the old address; follow `audit-rules.md` §10.3.

## Related
- `docs/process/release-and-deployment.md` §1 (D-88), §1.1 (hostnames), §4.5 (Workers pipeline), §5 (deploy record), §6 (secrets inventory), §8 (rollback).
- `docs/foundation/07-sdk-transport-storage.md` §7 (submitter), `05-contracts-occ-v2.md` §9 (faucet), `audit-rules.md` SUB-7.
- [RB-10](deploy-and-verify.md) deploying and verifying, [RB-11](rollback-and-freeze.md) rollback and `DEPLOY_FREEZE`.
