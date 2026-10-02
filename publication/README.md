# Publication preparation

This directory contains draft public listing and review metadata. The user selected Cloudflare hosting alongside WordInWeb for the standard public submission route. Deployment preparation is in `../deploy/README.md`. The installable local plugin remains in `../plugin/`.

## Current evidence

- The Cloudflare Worker was updated on October 1, 2026 (Pacific time), version `415e20d2-790f-4b28-9760-ccae06682ca2`. The public HTTPS check passed for health, tool discovery, editor HTML, host-granted URI preservation, local file URL rejection, command routing across separate HTTP clients, and session isolation. The verified endpoint is `https://word-in-gpt-mcp.callerinfo.workers.dev/mcp`, recorded in `mcp.json`. These checks use synthetic tool results; native hosted editing remains pending.

- Eight tests and TypeScript checking passed on October 1, 2026. These cover command routing, local file launching, session handling, local writes, exact selection offsets across text nodes and paragraphs, and plain text patches retaining heading formatting.
- Selection sharing and comments were verified in the local browser host at widths of 909 and 1250 pixels. The context contained the selected text, current revision, exact run offsets, and editor session ID. Narrow comments fit in a floating card; wide comments fit in the rail. Screenshot: `../dev/selection-comments-fixed.jpg`. Installed version `0.1.0+codex.20261002035902` is ready; the current native chat retains the earlier version until Codex restarts.
- `npm run test:package` passed against a fresh temporary copy of the bundled plugin. It verified startup, all five document tools, boolean annotations on every tool, the editor resource, local file launch, session routing, insertion, saved DOCX content, conflict detection, and an unchanged original fixture. Its editor adapter is headless; native UI and submitted-version review cases remain pending.
- Native Codex integration passed after the desktop restart. The installed launcher returned `word-local://`; the native panel showed **Chat connected** and **Saved**. Actual installed `word_document_inspect`, `word_document_capabilities`, and `word_document_edit` calls inserted `[Native integration passed] ` at the first nonempty body paragraph. The saved XML matched the expected body text, and `sample.docx` retained its original SHA-256. Screenshot: `../dev/native-integration-passed.jpg`. Tested installed version: `0.1.0+codex.20261001053239`.
- The public website at `https://word-in-web.com/` returned HTTP 200 and was opened in the browser. It identifies WordInWeb as a browser DOCX editor and links to its public GitHub project. `websiteURL` now records this existing publisher page. Public support, privacy, and terms URLs remain pending.
- `assets/icon.png` renders the existing SVG branding at 512 × 512 pixels.
- `plugin.json` drafts five positive and three negative review cases. All eight cases are **Not run** against the submitted public version.
- Installed version `0.1.0+codex.20261002041016` adds **Add to chat** as the first right-click menu item and renames the header button. Browser testing verified exact text and offsets for both one-word and two-paragraph selections. Screenshot: `../dev/add-to-chat-menu.jpg`. The current native chat needs a reload to use this new build.
- The text projection defaults to a compact content view, retaining only line/block references needed for patching. On `dev/sample.docx`, both reads covered 161 paragraphs: the compact projection was 29,942 JSON bytes versus 196,635 bytes for detailed formatting inspection, an 85% reduction. The measured engine times were 5.63 ms and 2.55 ms respectively; this is a payload reduction, not evidence of faster engine execution or end-to-end chat timing. Wording edits use project plus patch; detailed formatting uses inspection, the relevant schema, and edit. Evidence: `../dev/edit-speed-check.json`.
- Browser MCP rehearsal passed for search, the compact default projection, text patching with unchanged run formatting, centering, and host autosave. Evidence: `../dev/browser-edit-rehearsal.json`. This development rehearsal does not replace testing the saved public submission.
- `submission-draft.zip` contains the portable manifests, current skills, PNG branding, and review fixture. Its manifest and MCP configuration passed the published Agent Plugins 1.0 schemas. Missing public listing and review materials keep it at draft status.

## Next preparation items

1. The Cloudflare Worker and HTTPS MCP endpoint are deployed and verified. Verify native host-granted file behavior against the hosted release. The user selected publisher name “Word in web” and no payments; supported countries and publisher verification remain pending.
2. Supply and verify website, support, privacy, and terms pages. Confirm data collection, sharing, retention, deletion, and support practices before drafting policy claims. Hosted tool results can contain document text. Verify a dedicated UI domain for public review.
3. The native live edit/save test passed. Run the complete draft review cases against the final accepted release format. The fixture is prepared at `fixtures/review.docx`; reviewer access and native visual validation of this fixture remain pending.
4. Record and host the walkthrough below. Verify playback and reviewer access, then add the real `review.demo_recording_url`.
5. Once the remote endpoint and metadata are verified, assemble the portable public package with root `plugin.json`, remote `mcp.json`, skills, and assets. Inspect the final ZIP, including hidden files.

Country targeting, publisher verification, listing URLs, and demo URL remain pending. The draft records the supplied publisher name and commerce declaration. Retain the current brand color. Optional dark-mode assets can be added if requested.

## Demo walkthrough

Use a disposable `review.docx` containing “Quarterly review” and “Revenue increased this quarter.” Show the installed release version and the native desktop host. Start screen recording with prompts and results readable.

1. Open the file and show its name and **Chat connected** status.
2. Ask: “Summarize the open document in one sentence.” Show the actual inspection result and answer.
3. Ask: “Find every occurrence of Revenue in the open document.” Show the matching paragraph.
4. Ask: “Change Revenue increased this quarter. to Revenue grew this quarter. Keep the existing formatting.” Show the two content tool calls, changed text, and **Saved** status.
5. Ask: “Center the Quarterly review heading.” Show the resulting alignment and saved file.
6. Highlight a passage, right-click it, and show **Add to chat** first. Click it, then ask: “Tighten the highlighted text.” Show the actual selection context and result while keeping private session identifiers off screen.
7. Ask: “Email the open document to my accountant.” Show the explanation that email requires a separate service.
8. Reopen the saved DOCX and show the persisted wording and alignment. Stop recording and review playback before hosting it.

This walkthrough is a recording plan. Video capture and hosting remain pending. Keep account credentials, session identifiers, and unrelated private content outside the recording. Reviewer credentials belong in secure portal fields.

The available computer tools support screenshots and browser actions; video capture is unavailable here. Use the macOS screen recorder (Shift-Command-5) to record the editor and these prompts. The assistant can perform the walkthrough while the creator records it. Review the saved recording for readable results and private information, then host it at an accessible HTTPS URL before adding it to the manifest.

## Final portal work

After hosting and preparation are complete, an authorized draft upload can connect the remote server and run the review cases against the saved version. Confirm imported metadata, publisher/domain verification, scans, and required developer attestations. Submission for review and publication each have their own authorization and result.

## Local MCP support request draft

The earlier local-distribution request is retained in `local-mcp-request.txt` for reference. Cloudflare hosting uses the standard remote submission route.

Word in web is preparing a free Word document editor for the public ChatGPT/Codex directory. The plugin bundles a Node.js stdio MCP server that runs on each user’s device. Its MCP App displays the document in the desktop panel, and its tools inspect and edit the document through a private editor session. Users explicitly select the local DOCX to open, and changes save to that file. Node.js 22.18 or later is required.

Please confirm whether public directory distribution of this local MCP plugin is available, which package and review route to use, and which desktop hosts support the local runtime and file editor. We can provide the package, reproducible review fixture, review cases, and a native-host demonstration using the verified local integration.

This request is a draft for the publisher’s OpenAI contact. It has not been sent. Official route guidance: https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks

## Website preparation update — October 1, 2026

The supplied screenshot shows approved individual verification. Select the approved Developer identity in the plugin upload dialog and inspect its exact displayed publisher name. Public country targeting remains pending.

The publisher supplied alex@cobbery.com for support, stated that they do not collect data, and requested simple MIT terms and a friendly invitation to get in touch. Four static pages are prepared in `website/word-plugin/` and integrated into the existing word-in-web.com source in `/Users/alexpickett/Desktop/Projects/wordinweb-parity/apps/demo/public/word-plugin/`. The terms reproduce the existing WordInWeb MIT license. The privacy page explains transient hosted processing and still marks support-email and hosting-log retention as pending. These pages are prepared locally, not published or verified at their planned HTTPS paths. The submission manifest retains only verified live URLs.

Website build passed. Browser checks confirmed the contact address, navigation, invitation, MIT text, and visible privacy draft status. Evidence: `website/validation.json`, `website/support-preview.png`, and `website/terms-preview.png`. A local preview is available at http://127.0.0.1:8868/word-plugin/terms.html while the preview server runs.

## Website deployment — October 1, 2026

Deployed the prepared product, support, privacy, and terms pages to the existing `wordinweb-parity` Cloudflare Worker, version `fbc2a66b-b9ad-490d-a9b5-a3030e6b5f64`. The verified production domain is word-in-web.com. All four pages and their stylesheet returned HTTP 200 and matched the prepared source bytes; browser checks confirmed their content and navigation. The public manifest and rebuilt draft ZIP now include the canonical live URLs and draft publisher name Alex Pickett, consistent with the requested personal identity. Inspect the exact verified identity name in the portal. Privacy still visibly carries a support-email-retention draft note. Demo recording, country targeting, and final saved-version portal checks remain pending. Evidence: `website/live-verification.json`, `website/domain-verification.json`, `website/logging-verification.json`, and `website/support-published.png`.
