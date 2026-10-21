# Worker logging settings read-back (OPS-PRIV-1; 07 §7 for the submitter, 04 §4 for the drop, I-7).
# One program for every copy of the READBACK-SETTINGS block in deploy-submitter.yml and
# deploy-drop.yml, so the copies cannot drift. Input: the body of
# GET /accounts/{account_id}/workers/scripts/{script_name}/script-settings.
#
# Output: exactly the line `logging-settings: ok` when every condition holds. Otherwise one line
# per failed condition, naming it and describing each field it reads. A description is built only
# from this file's own field paths plus the JSON type and, for a boolean, number or null, the
# value (arrays and objects give their length; strings give their type only). It never prints a
# string from the response, a key the response chose, or the body: no URLs, tokens or IDs.
#
# Fails closed (IR-OPS-PRIV-1-1). Required: `success` true; `result` an object; `logpush` present
# and false; `observability` an object with `enabled` present and false. Optional, and then off:
# `observability.logs` (absent or null, it follows `observability.enabled`; present, `enabled`
# false is required), `observability.traces` (a missing `enabled` is accepted, IR-OPS-PRIV-1-2),
# `invocation_logs` and `destinations` inside them, `tail_consumers` (null when there are none)
# and `streaming_tail_consumers`. A field that is present must have the expected type.
#
# Not read, by design: the documented defaults that turn nothing on by themselves, such as
# `head_sampling_rate` (default 1), `persist`, `propagation_policy` (null when unused),
# `redact_query_string` and `tags`. With `enabled` false nothing is sampled or persisted.

def none: . == null or (type == "array" and length == 0);
def unset($k; f): (has($k) | not) or (.[$k] | f);
# A part of `observability` (logs or traces): absent or null, or an object meeting `f`.
def part($k; f): .result.observability | unset($k; . == null or (type == "object" and f));
def holds(f): (try f catch false) == true;

# For `destinations` only, whether every entry is the string "cloudflare" (a boolean).
def shape($destinations):
  type as $t
  | if $t == "boolean" or $t == "number" then "\($t) \(tojson)"
    elif $t == "null" then "null"
    elif $t == "array" then
      "array of \(length)"
      + (if $destinations and length > 0 then ", only \"cloudflare\": \(all(.[]; . == "cloudflare"))" else "" end)
    elif $t == "object" then "object with \(length) keys"
    else $t
    end;

# One field path, described without any value the response chose.
def describe($root; $p):
  ($p | join(".")) as $name
  | (try (
      ($root | getpath($p[:-1])) as $parent
      | if ($parent | type) != "object" then "not readable (parent is \($parent | type))"
        elif ($parent | has($p[-1]) | not) then "missing"
        else $parent[$p[-1]] | shape($p[-1] == "destinations")
        end
    ) catch "not readable") as $d
  | "\($name): \($d)";

def obs: ["result", "observability"];

. as $root
| [
    {name: "success", paths: [["success"]], ok: holds(.success == true)},
    {name: "result-object", paths: [["result"]], ok: holds((.result | type) == "object")},
    {name: "logpush-off", paths: [["result", "logpush"]],
     ok: holds(.result | has("logpush") and .logpush == false)},
    {name: "observability-object", paths: [obs],
     ok: holds((.result.observability | type) == "object")},
    {name: "observability-off", paths: [obs + ["enabled"]],
     ok: holds(.result.observability | has("enabled") and .enabled == false)},
    {name: "logs-off", paths: [obs + ["logs"], obs + ["logs", "enabled"]],
     ok: holds(part("logs"; .enabled == false))},
    {name: "invocation-logs-off", paths: [obs + ["logs", "invocation_logs"]],
     ok: holds(part("logs"; unset("invocation_logs"; . == false)))},
    {name: "log-destinations-none", paths: [obs + ["logs", "destinations"]],
     ok: holds(part("logs"; unset("destinations"; none)))},
    {name: "traces-off", paths: [obs + ["traces"], obs + ["traces", "enabled"]],
     ok: holds(part("traces"; unset("enabled"; . == false)))},
    {name: "trace-destinations-none", paths: [obs + ["traces", "destinations"]],
     ok: holds(part("traces"; unset("destinations"; none)))},
    {name: "tail-consumers-none", paths: [["result", "tail_consumers"]],
     ok: holds(.result | unset("tail_consumers"; none))},
    {name: "streaming-tail-consumers-none", paths: [["result", "streaming_tail_consumers"]],
     ok: holds(.result | unset("streaming_tail_consumers"; none))}
  ]
| map(select(.ok | not)) as $failed
| if ($failed | length) == 0 then "logging-settings: ok"
  else $failed[] | "failed \(.name): \([.paths[] as $p | describe($root; $p)] | join("; "))"
  end
