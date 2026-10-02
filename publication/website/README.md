# Word plugin website pages

Prepared October 1, 2026. Support contact supplied by the publisher: alex@cobbery.com.

The `word-plugin/` folder contains four static pages and one stylesheet. They use system fonts and contain no JavaScript, analytics, cookies, or forms. The email buttons open the reader's email application.

## Hosting preparation

The existing word-in-web.com source is `/Users/alexpickett/Desktop/Projects/wordinweb-parity/apps/demo/`. The pages are copied to that app's `public/word-plugin/` directory, and the existing website navigation links to `/word-plugin/index.html`. They are included in its normal Vite build. Publishing uses that website's existing Cloudflare deployment; the plugin relay needs no changes.

Published and verified URLs:

- Website: https://word-in-web.com/word-plugin/
- Support: https://word-in-web.com/word-plugin/support
- Privacy: https://word-in-web.com/word-plugin/privacy
- Terms: https://word-in-web.com/word-plugin/terms

All four pages and the stylesheet return HTTP 200 after redirects and match the prepared source bytes. Browser checks confirmed the actual page contents. The public manifest and draft ZIP record these live URLs. The publisher confirmed that support emails are kept. The privacy notice states that they remain in the mailbox until deleted; its draft label is removed. The package still needs the actual demo recording, country targeting, and final portal checks.

## Publisher decisions before publishing

Individual verification is approved in the supplied screenshot. The package-upload dialog selects the verified Developer identity. Inspect its exact public name there; these page drafts use Alex Pickett from the established project context.

The publisher states that they do not collect data. The draft describes document processing only for requested editing and chat. Support-email retention is confirmed: kept in the publisher’s mailbox until deleted. The deployed Cloudflare settings show Logpush disabled and no observability configuration for the relay or website; provider infrastructure processing is described separately in the notice. The published notice now includes this retention statement.

The publisher requested simple MIT terms and trust in responsible use. The terms page quotes the actual WordInWeb LICENSE verbatim and adds a short note about reviewing edits and keeping backups. It imposes no additional jurisdiction or age policy. The privacy notice is finalized for the supplied retention practice. Country targeting remains a separate public-submission choice.

## Technical evidence for the privacy draft

- `src/app/host.ts`: host-granted document reads/writes; the hosted plugin uses the host for complete DOCX bytes.
- `src/app/controller.ts`: in-panel document session; selected text sent through `ui/update-model-context`; requested edits autosave through the host.
- `src/app/server-tools.ts`: tool results, which can contain document text, returned through the relay.
- `src/server/editor-sessions.ts`: active session map in memory; removed on disconnect or after approximately 90 seconds without polling; pending commands expire after 45 seconds.
- `src/server/worker.ts`: Cloudflare relay; no application database writes.
- Repository audit found no analytics integration, document-content log calls, or persistent hosted document store in plugin source. This does not establish deployed provider settings or publisher practices.

The existing WordInWeb browser editor and collaboration service have separate implementation and data flows. These notices cover the Word plugin and its information pages only.

## Recording preparation

The demo fixture and recording prompts are in `../fixtures/review.docx` and `../README.md`. Record the actual walkthrough with the macOS screen recorder, inspect playback, and host the resulting video at a reviewer-accessible HTTPS URL. The recording has not been created.

The publisher also requested a friendly invitation at the top of the pages. All four pages link that invitation to alex@cobbery.com. The website changes were deployed to wordinweb-parity on October 1, 2026, version fbc2a66b-b9ad-490d-a9b5-a3030e6b5f64. Cloudflare domain lookup confirmed word-in-web.com belongs to that service. The deployment uses a clean staging build and excludes unrelated untracked test files.

Privacy was updated and verified on October 1, 2026, deployment eed2e0e5-b928-4fe5-b507-55d8fe1069b0. The exact live bytes matched the revised source.
