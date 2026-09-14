#!/usr/bin/env bash
# Run one SQL script against the live project via the Supabase Management
# API's database/query endpoint. This is the fallback (and diagnostic) path
# used by deploy-ninja-analytics.yml when a direct Postgres connection isn't
# available - it authenticates with SUPABASE_ACCESS_TOKEN alone, no
# SUPABASE_DB_PASSWORD, no `supabase db push`.
#
# Usage: mgmt_sql.sh "<sql>"
# Requires SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF in the environment.
#
# Always prints the HTTP status and the raw response body (no secret ever
# appears in a query result, so this is safe to log in full) - this step is
# genuinely exploratory the first time it runs against this project, so every
# call must be fully observable rather than parsed through an assumed shape.
# Exits non-zero on a non-2xx response.

set -euo pipefail

sql="${1:?usage: mgmt_sql.sh <sql>}"
: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"
: "${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is required}"

body=$(jq -n --arg q "$sql" '{query: $q}')

http_code=$(curl -sS -o /tmp/mgmt_sql_response.json -w '%{http_code}' \
  -X POST "https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$body")

echo "--- Management API database/query: HTTP $http_code ---" >&2
cat /tmp/mgmt_sql_response.json >&2
echo >&2

if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
  echo "Management API call failed (HTTP $http_code)." >&2
  exit 1
fi

cat /tmp/mgmt_sql_response.json
