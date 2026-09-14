#!/usr/bin/env bash
# Fetch ONLY the browser-safe publishable/anon API key for the linked Supabase
# project, via the Management API - never the secret/service_role key.
#
# Requires SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF in the environment.
# Prints the key to stdout on success (masked from the workflow log via
# ::add-mask::) and nothing else. Exits non-zero, with a diagnostic that
# prints key names/types but never key VALUES, if the response doesn't
# contain exactly one unambiguous publishable/anon key.

set -euo pipefail

: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"
: "${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is required}"

http_code=$(curl -sS -o /tmp/api_keys_response.json -w '%{http_code}' \
  -X GET "https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/api-keys" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}")

if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
  echo "Management API api-keys call failed (HTTP $http_code)." >&2
  # Safe to print in full: an error body from a failed auth/lookup call
  # carries no key material.
  cat /tmp/api_keys_response.json >&2
  exit 1
fi

# Diagnostic listing: names and types only, never api_key values - safe to
# print even for the rejected (secret/service_role) entries.
echo "Keys returned by the Management API (names/types only):" >&2
jq -c '[.[] | {name, type}]' /tmp/api_keys_response.json >&2

# Accept either API key generation:
#   legacy:  {"name": "anon", ...}          vs {"name": "service_role", ...}
#   current: {"type": "publishable", ...}   vs {"type": "secret", ...}
# Explicitly exclude anything that looks like a secret/service key rather
# than assuming "not secret" means "safe" - an unrecognized shape must fail
# closed, not fall through to picking the wrong key.
candidates=$(jq -c '[
  .[] | select(
    (.type == "publishable") or
    ((.type == "legacy" or .type == null) and (.name == "anon"))
  ) | select(
    (.type != "secret") and (.name != "service_role")
  )
]' /tmp/api_keys_response.json)

count=$(echo "$candidates" | jq 'length')

if [ "$count" -ne 1 ]; then
  echo "Expected exactly one publishable/anon key, found $count. Refusing to guess." >&2
  exit 1
fi

key=$(echo "$candidates" | jq -r '.[0].api_key')

if [ -z "$key" ] || [ "$key" = "null" ]; then
  echo "Matched key entry has no api_key value." >&2
  exit 1
fi

echo "::add-mask::$key"
echo "$key"
