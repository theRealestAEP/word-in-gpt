# Cloudflare Workers deployment

WordInWeb's `wordinweb-parity` project publishes through Cloudflare Workers.
This repository deploys the MCP service as `word-in-gpt-mcp` in the same account.
Its configuration is `../wrangler.jsonc`.

Verified endpoint: `https://word-in-gpt-mcp.callerinfo.workers.dev/mcp`.
Updated October 8, 2026 (Pacific time), version `691d6dd0-5b5d-4434-8c70-1f06f8938d6a`.
The public HTTPS check passed for health, tool discovery, editor HTML, URI
handling, command routing, and session isolation.

The live server reports version 0.1.4. Its 138 individual edit tools publish
their schemas and annotations upfront. The two openers have distinct display
names. Live verification centered the review fixture's heading through
`word_document_format_paragraph`, exported and reopened the DOCX, and confirmed
the original heading style and text. The served editor matches the built HTML.
The public submission package and portal scan require separate updates.

The backend builds the 142 document-tool schemas once per runtime and reuses
them across requests. A local 100-request setup benchmark fell from 1.34 ms to
0.22 ms per server construction; this measures setup, not total request latency
or Cloudflare CPU time. All 19 tests and typechecking passed. The live HTTPS
relay check passed, the published tool catalog exactly matches the prior
catalog, and the live editor HTML matches the build. The schema reuse remains
in place alongside the WebSocket command connection.

The Worker serves MCP Streamable HTTP at `/mcp` and editor WebSockets at
`/editor/<editorSessionId>`. A Durable Object routes model requests and socket
replies to the same private session. Cloudflare accepts the sockets through its
hibernation API and restores their session IDs from socket attachments when the
object wakes. An idle connected editor sends no command polls or heartbeats.
Model calls immediately push commands to the matching editor; replies return
over the socket. Commands time out after 45 seconds and close their session so
late results cannot count as successful edits. Unattached sessions expire after
90 seconds. The editor reconnects with the same session ID after a dropped
socket or mobile page resume, using retry delays from 500 ms up to 10 seconds.
The editor HTML, icon, and synthetic review.docx fixture use the ASSETS binding.
Editor-v18 serves previously published v5-v17 template URIs to preserve saved connections.
The local stdio and Node development servers retain the existing command-poll
transport; the deployed Worker advertises WebSockets to the editor. Legacy poll
and reply tools remain for cached clients.
Uploaded attachment reopening restores bytes from ChatGPT tool metadata or its authorized file API; the Worker retains no document copy.

WebSocket verification passed 34 automated tests, typechecking, the local package
check, and an actual Cloudflare runtime check. The live HTTPS endpoint routed
real DOCX reads and heading centering through WebSockets, preserved the heading
style and text in the exported document, isolated two simultaneous editor
sessions, kept their sockets open for 100 seconds without polling or heartbeats,
and reconnected with the original session ID. Hibernation restoration and
closing-socket filtering also passed a constructor reconstruction test. Actual
ChatGPT web/mobile WebSocket loading and the host's CSP enforcement still need
host verification; Chrome remained with the user during this change.

## Errors and limits

When the Worker cannot reach the Durable Object, or the rate limiter fails, it
answers 503 (or lets the request through) and stores one record in the
`ERROR_LOG` KV namespace for 30 days. A record holds the stage, route, error
name, message, Cloudflare's `retryable` and `overloaded` flags, and the stack.
It never holds the URL, session ID, IP address, or body. List them with:

```sh
npm run errors
```

Requests over the per-IP rate limits receive 429. The limits are in
`wrangler.jsonc`. Cloudflare counts them per location, so short bursts can pass.

## Development and deployment

```sh
npm run dev:worker
node dev/check-http-server.mjs http://127.0.0.1:8787/mcp
node dev/check-websocket.mjs http://127.0.0.1:8787/mcp
```

Check Wrangler's output for the actual local port. The HTTP check verifies tool
discovery, editor HTML, URI handling, session routing, and session isolation with
synthetic results. Native desktop editing and saving have a separate review check.

Deploy with the authenticated WordInWeb Cloudflare account:

```sh
npm run deploy:worker
```

Wrangler builds the editor, copies its assets, and uploads the Worker and its
Durable Object migration. Use the HTTPS URL returned by Wrangler, with `/mcp`,
as the remote endpoint. Verify it with the same HTTP check.

The service can also use a custom hostname in the WordInWeb domain through
Cloudflare's Worker domain settings. Verify that hostname before adding it to
the plugin configuration. The public review also needs a dedicated UI domain.

The Worker serves the current OpenAI domain verification token as plain text at
`/.well-known/openai-apps-challenge`. Its public HTTPS response was checked for
status 200 and an exact token match. Complete verification in the plugin portal
with the default challenge base URL.

## Data flow

ChatGPT uploads use the standard file-input descriptor. The opener passes the
authorized download URL in private tool metadata and creates the editor session
without fetching the DOCX. The editor downloads the HTTP response directly from
file storage. Fetch streams the response over the network; WordInWeb receives
the complete bytes after the browser collects them. Azure Blob and OpenAI file
storage domains are declared in the editor's connection CSP.

If the browser download fails, the app-only `word_attachment_read` tool returns
a private Worker download link. Its random token expires after 90 seconds.
The Worker retains the authorized source URL during that period and forwards
the source response body as a stream, with no document buffering or storage.
The editor collects the bytes locally for WordInWeb's DOCX parser. The hosted
Node development server still supports the older base64 fallback. Saved results
containing `fileBlob` continue to load, and expired download links can be
refreshed through the host file API when it accepts the attachment's file ID.
Neither download links nor file bytes enter model-visible tool output.

The change passed 25 tests, typechecking, and the local package check. The
stream test receives the first bytes before the source closes and verifies
that unknown and expired download tokens return 404. ChatGPT initially loaded
a cached editor that could not read the new private URL. Refreshing tools on
the private test connection loaded the current editor and restored opening
and inspection. The deployed HTTPS relay and streamed fallback checks passed
after Cloudflare's Durable Object finished updating from v15 to v16.
The final v16 ChatGPT browser check was started but its result was not observed
before the user resumed using Chrome. Production CSP and physical mobile
verification remain separate host checks.

For a published plugin, OpenAI reviews the added app-only download tool, new UI
resource reference, and CSP changes through continuous tool review. The app
listing and MCP origin remain the same. If the draft is still in review, updating
its stored scan requires cancelling review, scanning again, and resubmitting
the same draft. This deployment did not change the public portal submission.
See [OpenAI's maintenance requirements](https://developers.openai.com/plugins/deploy/app-review#ongoing-maintenance).
The browser holds the edited
copy; Download DOCX exports it through the host file API or a browser download.
Host-granted files use the desktop resource bridge for reading and autosave.
Model commands and results pass through the hosted relay and can contain document
text. The relay keeps sessions and pending commands in memory. This flow is
described in the deployed privacy page.

Public submission preparation is tracked in `../publication/README.md`.

Cloudflare documents [remote MCP on Workers](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
and [Durable Object state](https://developers.cloudflare.com/durable-objects/api/state/).

Increment EDITOR_VERSION in src/server/server.ts for every deployed UI change. Hosts cache templates by URI; verify the live resource matches plugin/dist/app.html after deployment.

## Free-plan budget

Cloudflare's Workers Free plan provides 100,000 dynamic requests per day and
10 ms CPU per Worker invocation. Durable Objects separately provide 100,000
requests and 13,000 GB-seconds of active duration per day. These quotas are
shared with other workloads in the account. Each MCP request uses a Worker
request and a Durable Object request. Tool calls, initialization, resource reads,
attachment fallbacks, and socket upgrades consume requests. Incoming WebSocket
messages count toward Durable Object requests at Cloudflare's documented ratio
of 20 messages per request. Outgoing WebSocket messages incur no request charge.
Connected idle editors generate zero application command polls. Hibernation
stops active-duration billing while the relay meets Cloudflare's idle criteria;
active tool calls and short-lived download expiry timers can keep it awake.
Cached editors that still use the legacy polling transport retain its traffic
until they reopen with the current UI.

The shared relay lets concurrent sessions share its active-duration allowance.
One 128 MB relay active for a full day uses about 11,000 GB-seconds, within the
13,000 allowance if other Durable Objects leave enough quota. The relay stores
sessions in memory and uses no application SQL reads or writes. The free SQL
allowance is 5 GB total, 5 million rows read/day, and 100,000 rows written/day.
Free-plan operations fail when their quota is exhausted; daily quotas reset at
00:00 UTC.

Cloudflare's Free account request-body limit is 100 MB and isolate memory is
128 MB. The browser downloads DOCX bytes directly or collects a streamed Worker
fallback locally. The Worker stores only the short-lived authorized URL for
that fallback. The body limit is a transport limit, not a supported DOCX size:
WordInWeb needs the full file in browser memory to parse it. The plugin currently
has no overall serialized-body or DOCX byte cap.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
