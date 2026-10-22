# Faucet and gas pool alert (M1-10b-e). Input: the body of the production submitter's public
# GET /v1/health. Run by .github/workflows/submitter-pool.yml; tested on fixtures in
# tools/release/submitter-pool.test.mjs.
#
# Output: exactly the line `pool: ok` when the answer lists at least one chain and every chain is
# available, its gas wallet is `ok`, and its faucet is `ok` or null (the chain has no faucet).
# Otherwise one `alert ...` line per finding. A line holds only a chain ID (a number) and fixed
# words of this file: never a balance, an address or any other string from the answer. An answer of
# another shape (an older submitter without the pool states, or anything malformed) is an alert,
# so the check fails closed.

def chainid: if (.chainId | type) == "number" then (.chainId | tostring) else "?" end;
def gasword: if .gas == "ok" or .gas == "low" then .gas else "unknown" end;
def faucetword:
  if .faucet == "ok" or .faucet == "low" or .faucet == "paused" then .faucet else "unknown" end;

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
        (if .faucet == "ok" or (has("faucet") and .faucet == null) then empty
         else "alert chain \(chainid): faucet \(faucetword)" end)
      end
  ]
  | if length == 0 then "pool: ok" else .[] end
end
