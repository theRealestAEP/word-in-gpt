# Publication preparation

## Current package — November 2, 2026

The current ZIP is `word-in-chat-0.1.5.zip`; `submission-draft.zip` contains the
same package. Its manifest declares version 0.1.5. It has the same nine files as
0.1.4. The only content change is step 1 of the `word-editor` skill: in Codex,
the model passes a local .docx path to `open_word_document`. The old text sent
it to `open_word_resource` with a `file:///` URL, which the hosted server refuses.

The live Worker (version `0acd60fe-bb0b-41ea-bafa-7a9f567cd4c5`) serves
editor-v22. Changes since 0.1.4 that the portal scan sees:

- The tool metadata references `ui://word-in-gpt/editor-v22` (was v19).
- Download DOCX first posts the edited copy to `/exports` on the same Worker.
  The Worker keeps it in memory for 90 seconds and returns a one-time link. The
  editor asks the host to open that link with `ui/open-link`. The Codex app
  cancels downloads inside the editor and ignores `ui/download-file`, so this
  is the only export path that works there. The ChatGPT file API path and the
  browser download remain as fallbacks.
- The open-tool descriptions and the `file:///` refusal now name the call that
  opens a local path in Codex.

Fifty-seven tests and typechecking pass. In the Codex app, a new thread opened a
local .docx on the first request, and Download DOCX saved a valid copy to
Downloads. The ChatGPT web and mobile export through `ui/open-link` is not yet
tested. Review cases 4 and 5 depend on it.

## Previous package — October 8, 2026

The current ZIP is `word-in-chat-0.1.4.zip`; `submission-draft.zip` contains the
same package. Its manifest declares version 0.1.4. The nine packaged files are
the manifest, remote MCP configuration, icon, review fixture, and two skills
with their references. Internal README files and validation notes are excluded.

The live Cloudflare endpoint serves editor-v18 with WebSocket command delivery,
hibernation, reconnection, direct authorized attachment downloads, and an HTTP
streaming fallback. Thirty-four tests, typechecking, the local package check,
and live WebSocket DOCX editing, export, routing isolation, 100-second idle
survival, and reconnection checks pass. Deployment evidence is in
`../deploy/README.md`. The public portal draft has not been changed by this
update; its saved MCP scan must include the current editor reference and CSP.
Actual ChatGPT web/mobile WebSocket host checks remain pending.

## Previous status — October 7, 2026

Version 0.1.1 received Changes required in the portal. The rejection says one or more submitted test cases produced incorrect results on ChatGPT web or mobile. The portal provides no failed-case transcript. The verified Developer identity is Alex Pickett; the skills show Checks passed.

Version 0.1.2 fixes a concrete compatibility problem: the hosted opener previously required a desktop resource URI. It now accepts ChatGPT's standard uploaded-file descriptor. The selected DOCX downloads through the Worker and reaches the editor in private tool metadata. Edits remain in the browser copy, and Download DOCX exports them through ChatGPT's file API. Host-managed files retain autosave. The loading guard now clears after opening, so later documents can open.

The MCP Worker is deployed as `d4fcea13-d6c0-4142-9406-e97ba0154ce2`. The website and privacy updates are deployed as `50424144-1139-405b-9e5d-1e87d7527fd4`. Live pages match their source. The synthetic fixture is public at https://word-in-gpt-mcp.callerinfo.workers.dev/review.docx.

Seventeen automated tests, TypeScript checking, the build, isolated local-plugin checks, and live HTTPS routing checks pass. The actual editor passes reading, searching, text rewriting, heading centering, and export tests in a browser host with no desktop resource capability. Its layout also passes at 390 × 844 pixels.

ChatGPT web testing uses a private custom MCP connection to the deployed endpoint. The uploaded fixture opens with Chat connected; summary, Revenue search, wording replacement, and centering return the expected results. The actual downloaded DOCX has Revenue grew this quarter., centered Heading1, and preserved run formatting. The email request asks for the recipient and exported copy; the purchasing request explains that purchasing needs another workflow. The Drive request uses the separately connected Google Drive plugin. Boundary expectations now allow other connected services while keeping Word in Chat scoped to document operations.

The five positive cases returned the expected results in two fresh-document web runs. The second run exposed a closed editing connection after the edits completed. The current build adds automatic reconnection and closes the previous file's session when another file opens. Its regression checks, including the actual deployed Cloudflare relay through a localhost host proxy, verify that reconnection preserves edited text and centered formatting. The complete 0.1.2 ZIP imported with one MCP and two skills; OpenAI marks this private import Desktop only. It cannot provide the real mobile test route. Final fresh-install reconnection, skill activation, and real ChatGPT mobile verification remain pending. A phone-sized browser checks responsive layout only. The private custom MCP connection exercises the hosted runtime; final public ZIP skills and saved-version portal checks still need verification. The existing Drive recording shows the native desktop pleading demo; it does not show the new attachment and export path. No replacement upload, resubmission, or GitHub push has occurred.

Real iPhone Safari testing reached the direct MCP opener. User screenshots showed a missing UI template, a rendered editor with a tools/call timeout, and an empty editor after reopening without attachment bytes. The deployed editor-v13 serves prior template URIs, recovers closed/timed-out relay sessions, keeps mobile buttons in a separate row with fixed-height statuses, and restores original attachment bytes from ChatGPT persisted tool metadata or its authorized file API. The desktop resource opener rejects temporary upload handles and directs the model to the original attachment parameters. Opening tool output now says loading is pending and requires a successful document inspection before claiming completion. A full browser reload with omitted private bytes passed in the development host. These fixes still need the real phone review cases; edited browser copies must be downloaded to retain their edits.

Editor-v13 also keeps the opening session ID across timeout and inactivity recovery. A forced disconnect passed with model-context forwarding disabled, preserving edited contents. Mobile Select text enables touch dragging through the existing document selection handler; synthetic touch selection and Add to chat passed at phone width. Physical iPhone gesture and model context delivery remain pending.

A later iPhone screenshot shows the correct fixture and Chat connected, while ChatGPT says the editor session ID is unavailable. Both opening tools now return the shared session ID directly to the model, and the panel joins that exact session. A real editor test against Cloudflare passed read, search, rewrite, center, and same-file reopening while the host deliberately omitted forwarding editor context to the model. Eighteen tests, TypeScript, build, isolated local package, and live HTTP checks pass. The public 0.1.2 candidate ZIP was rebuilt with the shared-session instructions and opening/inspection review expectation. Actual mobile completion remains pending after these changes.

Use the v0.1.2 candidate ZIP for testing. Complete the real mobile cases and saved-version checks before resubmitting. Full evidence is recorded in `draft-validation.json`.

## Historical preparation ledger

The notes below describe earlier versions and preserve their evidence. The current status above supersedes their pending-item lists.

This directory contains draft public listing and review metadata. The user selected Cloudflare hosting alongside WordInWeb for the standard public submission route. Deployment preparation is in `../deploy/README.md`. The installable local plugin remains in `../plugin/`.

## Current evidence

- The Cloudflare Worker was updated on October 2, 2026 (Pacific time), version `c72ad163-52c4-4322-ad3e-a2c95122a8ba`. The public HTTPS check passed for health, tool discovery, editor HTML, host-granted URI preservation, local file URL rejection, command routing across separate HTTP clients, and session isolation. The verified endpoint is `https://word-in-gpt-mcp.callerinfo.workers.dev/mcp`, recorded in `mcp.json`. These checks use synthetic tool results; native hosted editing remains pending.

- Eight tests and TypeScript checking passed on October 1, 2026. These cover command routing, local file launching, session handling, local writes, exact selection offsets across text nodes and paragraphs, and plain text patches retaining heading formatting.
- Selection sharing and comments were verified in the local browser host at widths of 909 and 1250 pixels. The context contained the selected text, current revision, exact run offsets, and editor session ID. Narrow comments fit in a floating card; wide comments fit in the rail. Screenshot: `../dev/selection-comments-fixed.jpg`. Installed version `0.1.0+codex.20261002035902` is ready; the current native chat retains the earlier version until Codex restarts.
- `npm run test:package` passed against a fresh temporary copy of the bundled plugin. It verified startup, all five document tools, boolean annotations on every tool, the editor resource, local file launch, session routing, insertion, saved DOCX content, conflict detection, and an unchanged original fixture. Its editor adapter is headless; native UI and submitted-version review cases remain pending.
- Native Codex integration passed after the desktop restart. The installed launcher returned `word-local://`; the native panel showed **Chat connected** and **Saved**. Actual installed `word_document_inspect`, `word_document_capabilities`, and `word_document_edit` calls inserted `[Native integration passed] ` at the first nonempty body paragraph. The saved XML matched the expected body text, and `sample.docx` retained its original SHA-256. Screenshot: `../dev/native-integration-passed.jpg`. Tested installed version: `0.1.0+codex.20261001053239`.
- The public website at `https://word-in-web.com/` returned HTTP 200 and was opened in the browser. It identifies WordInWeb as a browser DOCX editor and links to its public GitHub project. `websiteURL` now records this existing publisher page. Public support, privacy, and terms URLs remain pending.
- `assets/icon.png` renders the existing SVG branding at 512 × 512 pixels.
- `plugin.json` drafts five positive and three negative review cases. All eight cases are **Not run** against the submitted public version.
- Installed version `0.1.0+codex.20261002041016` adds **Add to chat** as the first right-click menu item and renames the header button. Browser testing verified exact text and offsets for both one-word and two-paragraph selections. Screenshot: `../dev/add-to-chat-menu.jpg`. The current native chat needs a reload to use this new build.
- Installed version `0.1.0+codex.20261002170530` anchors **Add to chat** at the top right and preserves text selection on right-click and macOS Control-click. Browser checks verified exact selection sharing, ordinary left-click behavior, and unchanged button coordinates through unsaved and saved states at widths of 709 and 360 pixels. TypeScript, eight tests, and the isolated bundled-plugin check passed. Evidence: `../dev/selection-toolbar-verification.json` and `../dev/selection-toolbar-fixed.jpg`. The current native chat still loads the previous build; restart Codex to verify this update in the native panel.
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

The prepared recording copy is `../dev/recording-review.docx`. The native panel showed **Add to chat**, **Chat connected**, and **Saved** after the October 2 restart. A later update fixes toolbar movement and right-click selection; restart Codex again to load version `0.1.0+codex.20261002170530` before recording. Its **Add to chat** button sits at the top right, with save and connection status below.

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

## Privacy finalization and recording stage — October 1, 2026

The publisher confirmed support emails are kept. The privacy page now says they remain in the mailbox until deleted, and its draft label is removed. The revised page was deployed and its live contents verified. A clean recording document was copied to `dev/recording-review.docx` and opened in the native Word panel with Saved and Chat connected. The panel still showed the older selection button label; restart Codex and verify the updated Add to chat UI before rehearsal and recording. No video has been recorded.

## Shared demo recording — October 2, 2026

The publisher supplied a Google Drive link to demo.mp4. Signed-out browser playback passed; the player reports 1 minute 24 seconds. The video shows the California pleading demo. The verified link is recorded in `plugin.json` as `review.demo_recording_url` and included in the rebuilt `submission-draft.zip`. The recording stays on Google Drive. Country targeting, the exact verified portal identity, and saved public-version review cases and portal checks remain pending. This update supersedes earlier notes that recording and hosting were pending.

## Country targeting — October 2, 2026

The publisher selected all countries supported by the directory. `publication.countries` is explicitly an empty list, which removes country restrictions. The rebuilt archive contains this confirmed targeting. The exact verified identity and saved-version connection, review cases, scans, and developer attestations remain portal work.

## Word in Chat name and portal handoff — October 2, 2026

The publisher selected Word in Chat, with the subtitle View and edit DOCX files. The public ZIP and local source manifest use that name; the technical identity remains word-in-gpt. Build, TypeScript, ZIP inventory/metadata, and Agent Plugins schema checks passed. The hosted MCP now reports Word in Chat (Worker a1ad5faa-e874-4fd3-b75b-5468c61ed2ff), and its transport check passed. The four live website pages match the renamed source (website Worker e3fafe19-e91a-42f2-86e0-a335e832727f). An unrelated fixture and .DS_Store copied by the website build were removed from the generated deployment; their live URLs returned 404. Source files were preserved. The installed local runtime has not been reinstalled for this display-name change.

The submission portal is open at https://platform.openai.com/plugins and requires sign-in. Draft upload, exact verified identity selection, connection/domain setup, automated scans, saved-version review cases, and developer attestations remain pending. No portal upload or review submission has occurred. The Drive video URL remains in the local submission metadata; these changes have not been pushed to the public repository.

## Individual identity selector issue — October 2, 2026

After sign-in, the Personal organization settings show Individual verification Approved and Business Tangia preverified for app submission. The plugin upload selector offers only Business — Tangia, including after one page refresh. Official app-review guidance explicitly supports individual verification for publishing under a personal name. This appears to be a portal identity-availability issue; its internal cause is unverified. No ZIP was uploaded under the business identity. A support request draft is saved in individual-identity-support.txt and has not been sent.

## Browser network diagnosis — October 2, 2026

The publisher authorized computer-use diagnosis. Chrome DevTools confirmed GET https://api.openai.com/v1/dashapi/plugins/identities returned HTTP 200 with exactly one entry: display_name Tangia, entity_type business. Thus the response is populated but omits the approved individual identity. The referenced community discussions supply diagnostics and Support escalation, not a demonstrated client-side workaround. The internal synchronization cause remains unverified. A screenshot, diagnostic JSON with organization/project context, and a support message were saved outside the repository in the Desktop folder Word in Chat identity diagnostics. They have not been sent. Request ID was not captured. No upload or publisher switch occurred.

Direct individual upload was attempted through the portal API on October 2, 2026. OpenAI returned `status=invalid` with `developer_identity_unavailable`: "No verified individual identity is available for this organization." No plugin or submission was created. The request ID and timestamp are in the private Desktop diagnostics folder.

## Narrowed skill scope — October 6, 2026

Prepared local version 0.1.1 with skill descriptions and instructions scoped to the DOCX open in Word in Chat. Removed the invitation bridge, offline and collaboration sessions, headless creation guidance, and unsupported compose/save/asset tool documentation. Preserved the current editor tools and runtime. The updated submission-draft.zip passed manifest and MCP schema validation, ZIP integrity, relative-reference checks, source/archive consistency, and checks for removed workflows. The previous ZIP is preserved as submission-0.1.0.zip.

The user screenshot shows the existing portal version In review, with a configured MCP and verified domain. All tools show Not live; capabilities and edit have further-review findings. The user requested preserving the active review. No portal change or replacement upload was made. Keep the corrected ZIP for a later upload.
