# Faucet and gas pool alert (M1-10b-e). Input: the body of the production submitter's public
# GET /v1/health. Run by .github/workflows/submitter-pool.yml; tested on fixtures in
# tools/release/submitter-pool.test.mjs.
#
# Output: exactly the line `pool: ok` when the answer lists at least one chain and every chain is
# available, its gas wallet is `ok`, and its faucet is `ok`. Otherwise one `alert ...` line per
# finding. `faucet: null` is a finding (`faucet off`, M1-10b-e-b): the submitter answers null for a
# chain missing from its faucet settings, and for every chain when those settings are missing or
# invalid, and the production submitter serves testnets only, where the faucet is expected
# (D-120 (3)). A chain served without a faucet (a mainnet, later) needs an explicit exception here. A line holds only a chain ID (a number) and fixed
# words of this file: never a balance, an address or any other string from the answer. An answer of
# another shape (an older submitter without the pool states, or anything malformed) is an alert,
# so the check fails closed.

def chainid: if (.chainId | type) == "number" then (.chainId | tostring) else "?" end;
def gasword: if .gas == "ok" or .gas == "low" then .gas else "unknown" end;
def faucetword:
  if .faucet == "ok" or .faucet == "low" or .faucet == "paused" then .faucet
  elif has("faucet") and .faucet == null then "off"
  else "unknown" end;

if (type != "object") or ((.chains | type) != "array") then
  "alert: malformed answer"
elif (.chains | length) == 0 then
  "alert: no chains served"
else
  [
    .chains[]
    | if type != "object" or (.chainId | type) != "number" then
        "alert: malformed chain"
      else
        (if .available == true then empty else "alert chain \(chainid): not available" end),
        (if .gas == "ok" then empty else "alert chain \(chainid): gas \(gasword)" end),
        (if .faucet == "ok" then empty else "alert chain \(chainid): faucet \(faucetword)" end)
      end
  ]
  | if length == 0 then "pool: ok" else .[] end
end
