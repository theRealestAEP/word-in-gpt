# Cloudflare Workers deployment

WordInWeb's `wordinweb-parity` project publishes through Cloudflare Workers.
This repository deploys the MCP service as `word-in-gpt-mcp` in the same account.
Its configuration is `../wrangler.jsonc`.

Verified endpoint: `https://word-in-gpt-mcp.callerinfo.workers.dev/mcp`.
Updated October 2, 2026 (Pacific time), version `c72ad163-52c4-4322-ad3e-a2c95122a8ba`.
The public HTTPS check passed for health, tool discovery, editor HTML, URI
handling, command routing, and session isolation.

The Worker serves Streamable HTTP at `/mcp`. A Durable Object owns the private
editor session map so model requests and editor polls reach the same relay.
The editor HTML and icon use the ASSETS binding. Each session expires after
90 seconds without polling. A relay restart closes active sessions; reopen
the editor to reconnect.

## Development and deployment

```sh
npm run dev:worker
node dev/check-http-server.mjs http://127.0.0.1:8787/mcp
```

Check Wrangler's output for the actual local port. The HTTP check verifies tool
discovery, editor HTML, URI handling, session routing, and session isolation with
synthetic results. Native desktop editing and saving have a separate review check.

Deploy with the authenticated WordInWeb Cloudflare account:

```sh
npm run deploy:worker
```

Wrangler builds the editor, copies its two assets, and uploads the Worker and its
Durable Object migration. Use the HTTPS URL returned by Wrangler, with `/mcp`,
as the remote endpoint. Verify it with the same HTTP check.

The service can also use a custom hostname in the WordInWeb domain through
Cloudflare's Worker domain settings. Verify that hostname before adding it to
the plugin configuration. The public review also needs a dedicated UI domain.

## Data flow

The editor loads and saves host-granted files through the desktop host. Model
commands and tool results pass through the hosted relay. Results can contain
document text. The relay keeps sessions and pending commands in memory.
Describe this flow and the operator's logging practices in the privacy policy.

Public submission preparation is tracked in `../publication/README.md`.

Cloudflare documents [remote MCP on Workers](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
and [Durable Object state](https://developers.cloudflare.com/durable-objects/api/state/).
