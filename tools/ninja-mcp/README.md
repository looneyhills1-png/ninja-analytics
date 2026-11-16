# Ninja Analytics MCP (private read-only bridge)

**Status:** experimental, snapshot-only. This MCP server reads Ninja Analytics' built-in full-portfolio JSON export (schema version 2). It does **not** retrieve live GA4, GSC, Bing or Amazon data and it does **not** refresh files automatically.

## Launch on Recoil

Use Node 20+ and the existing full-portfolio JSON export from Ninja Analytics. Store the export locally outside Git.

```powershell
$env:NINJA_EXPORT_FILE = 'C:\Ninja\ninja-analytics-export.json'
node tools/ninja-mcp/server.mjs
```

The server listens on **127.0.0.1:47831/mcp only**, with no external requests or packages. The four read-only tools are `list_sites`, `site_data`, `site_queries`, and `portfolio_summary`. Each data result has a `generated_at` timestamp and `source: snapshot`. Calls are bounded to 100 records and a 30 MiB export file.

## Connect to ChatGPT safely

ChatGPT cannot connect directly to localhost. Follow [Secure MCP Tunnel documentation](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) to run an outbound-only tunnel on Recoil targeting the local `http://127.0.0.1:47831/mcp` endpoint. Then in ChatGPT web open **Plugins → Add custom MCP server → Tunnel**, choose the registered tunnel, and add the private app. The current ChatGPT workspace must have tunnel and custom MCP permissions. Test the `list_sites` tool to verify live tunnel connectivity before declaring success.

Never expose this unauthenticated HTTP endpoint on a public address, open firewall/router ports, or commit exports or secrets. It relies on tunnel isolation for private connectivity, not application-level OAuth. Do not treat an uploaded GitHub commit as deployment. No scheduled refresh is included. For continuously fresh data, a separate, least-privileged, authenticated local reader needs to be connected to Ninja Analytics' existing session/RLS system, tested, and approved.

## Acceptance criteria

1. Node syntax passes.
2. Synthetic export can be read via `initialize`, `tools/list`, `tools/call`.
3. Unknown tools are rejected.
4. Server listens only on loopback and does not mutate data.
5. After local installation, OpenAI secure tunnel and ChatGPT list_sites call are independently verified.

Only the first four can be checked without the user's Recoil environment and ChatGPT workspace authorisation.
