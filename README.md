# Word in GPT

A ChatGPT and Codex plugin that opens `.docx` files in the [WordInWeb](https://word-in-web.com/) editor. The editor lays out pages the way Word does. You and the model edit the same open document, and each change saves back to the file.

## How it works

```
User opens report.docx in the ChatGPT / Codex desktop app
        │  (file entrypoint for ".docx")
        ▼
Host calls open_word_document ──► MCP server returns the editor UI (one HTML file)
        │
        ▼
Editor (MCP App in the side panel)
  • resources/read  ──► loads the file through the host
  • DocxView        ──► you edit with the full Word ribbon
  • live tools      ──► server routes word_document_* commands to the open editor
  • openai/resources/write ──► autosaves 1 s after each edit (with an ETag check)
  • resources/updated ──► reloads when another program changes the file
```

- Host-granted file bytes are read and saved through the host's resource bridge. The local stdio plugin also accepts an explicit `file:///` URL in `open_word_document`, grants an opaque handle to that one file, and saves it atomically with a content-hash version check. The HTTP server accepts host-granted files only.
- The MCP server serves the editor and relays commands and results in memory. Results can contain document text. The local file launcher also transports file bytes through the local MCP connection.
- The MCP server advertises the model's tools. The open editor establishes a private session, attaches its ID to model context, and receives commands through an app-only long poll. Commands execute against the document you see, using the browser's font metrics. The panel shows **Chat connected** when this connection is ready.
- Each model command includes `editorSessionId`. Sessions are isolated, expire after 90 seconds without polling, and close when the panel is torn down.
- The Cloudflare Worker routes MCP requests to a Durable Object that owns the editor sessions. The standalone Node HTTP entry runs as one process.
- When the file changes on disk while the editor has unsaved edits, the editor asks which version to keep.
- File entrypoints work only in the **desktop** app (ChatGPT desktop and Codex inside it). ChatGPT on the web and mobile does not support them.

| Path | What it is |
| --- | --- |
| `src/server/server.ts` | MCP server: the editor UI resource and the `.docx` file entrypoint tool |
| `src/server/stdio.ts` | Local entry, bundled to `plugin/dist/server.mjs` |
| `src/server/http.ts` | Hosted entry (Streamable HTTP at `/mcp`) for the public directory |
| `src/server/worker.ts`, `wrangler.jsonc` | Cloudflare Worker and Durable Object hosting |
| `src/app/` | The editor: host link, autosave and conflicts, live model tools, UI |
| `plugin/` | The installable plugin: manifest, `.mcp.json`, skills, icon, build output |
| `.agents/plugins/marketplace.json` | Repo marketplace, so Codex can install the plugin from this repo |
| `dev/mock-host.html`, `dev/server.ts` | A test host using the real MCP server, with optional saving to a test file |

## Build

Use Node.js 22.18 or later.

```bash
npm install
npm run build
```

The build writes `plugin/dist/app.html` (the editor, about 6 MB with all fonts inlined) and `plugin/dist/server.mjs`. Commit `plugin/dist`: Git marketplace installs copy the plugin folder as it is and do not run a build.

## Test without ChatGPT

Run `npm run test:package` to rebuild and check the bundled local server from a clean temporary installation. The check routes an edit through MCP using a headless editor adapter, reopens the saved DOCX, and checks conflict detection. It keeps the original review fixture unchanged. The native desktop panel has a separate verification gate.

The local test host uses the real MCP server. It simulates the desktop host's file bridge.

```bash
npm run demo
```

Open `http://127.0.0.1:8766/dev/mock-host.html?save=1`. Expand **Integration test**, then click **Test live editing**. The test discovers the server's five document tools, sends an edit through the server to the browser editor, and saves it to `dev/integration-live.docx`. The server creates that test copy from `dev/sample.docx` on first run. Opening the plugin and passing its session ID into a model call still require a test in Codex.

Omit `?save=1` for an in-memory file test. In the console:

- `await callApp("tools/list", {})` lists the model's live tools.
- `await callApp("tools/call", { name: "word_document_inspect", arguments: { kind: "context" } })` runs one.
- `externalChange(disk.b64)` simulates another program that changes the file.
- `disk.writes` counts autosaves.

Use `?save=1&local=1` to test the direct local launcher too: a `file:///` input resolves to an opaque file handle, and the opener supplies the same session ID to the editor and model. This exercises local file reads, live edits, and version-checked saves through the MCP server.

## Install locally in Codex / ChatGPT desktop

1. Build the plugin (see above).
2. Add this repo as a marketplace:

   ```bash
   codex plugin marketplace add <path-to-word-in-gpt>
   ```

   Use the current Codex CLI provided by the desktop app (`command -v codex` shows its location).

3. Restart the ChatGPT desktop app.
4. Open the Plugins Directory, select the **Word in GPT** source, and install **Word**.
5. In a Codex task, call `open_word_document` with `file.name` and the file's absolute `file:///` URL as `file.resourceUri`. Confirm **Chat connected** in the Word panel, then call the document tools with the session ID from its model context. Attachment and review links can open the built-in preview instead.

After you change the code, run `npm run build`, update the plugin version, and run `codex plugin add word-in-gpt@word-in-gpt` to reinstall. Start a new task to load the updated skills and tools.

## Share with other people (no review)

Push this repo to GitHub with `plugin/dist` committed. Other people run:

```bash
codex plugin marketplace add <owner>/word-in-gpt
```

Then they install **Word** from the Plugins Directory. This uses the local stdio server, so their machine needs Node.js.

## Publish to the public plugin directory

Cloudflare hosting alongside WordInWeb is prepared in [deploy/README.md](deploy/README.md).
It uses a Worker in the WordInWeb account and a Durable Object for editor sessions.
Run `npm run deploy:worker` to deploy through the authenticated Cloudflare account.
The verified remote endpoint is `https://word-in-gpt-mcp.callerinfo.workers.dev/mcp`.

The standard public submission route uses a remote HTTPS MCP endpoint. OpenAI's [plugin documentation](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks) directs developers who need local MCP distribution to contact OpenAI for local support. The editor runs in the desktop panel in either design; the hosted implementation relays model commands and results through its server.

Publication preparation is tracked in [publication/README.md](publication/README.md). The draft portable manifest contains the listing, five positive and three negative review cases, release notes, and the supplied publisher and commerce details. Its PNG icon uses the existing branding.

For the standard submission route, verify the actual hosted endpoint and dedicated UI domain, all four listing pages (website, support, privacy, and terms), supported countries, publisher identity, and a reviewer-accessible demo recording. Complete native host testing and run each review case against the release. Describe the actual data flows and retention in the privacy policy, including document text in tool results.

Once these materials are complete, assemble a separate public upload with root `plugin.json`, remote `mcp.json`, skills, and referenced assets. Use square PNG listing and composer icons; the prepared 512-pixel icon covers both sizes. Inspect the archive before uploading it as a draft. Portal connection and validation, submission for review, and publication are separate steps. Required attestations belong to the authorized developer.

## Use the editor

Highlight text and click **Add to chat**, or right-click the selection and choose **Add to chat**, the first menu item. This shares its text and edit references. Prose edits use the plain text projection and patch tools; formatting and layout edits use detailed operations. Comments use the side rail in wide panels and open as a floating card when the user clicks commented text in a narrow panel.

## Known limits

- The live tools require a connected editor session. To create a new document, or to edit one that is not open, the model uses the bundled `wordinweb-documents` skill (the `@wordinweb/agent` package). `plugin/skills/wordinweb-documents` is a copy from the WordInWeb repo.
- Undo (Cmd+Z) does not yet reverse the model's edits. The published `wordinweb` 0.3.2 has no `api.checkpoint()`. The source repo has it, so connect it after the next release.
- The editor HTML is about 6 MB, and 2.2 MB of that is fonts for every script (Latin, Greek, Cyrillic, Vietnamese). Fewer subsets make it smaller, but text in the removed scripts then measures with fallback fonts.
- Each autosave sends the whole file, as base64, through the host.
