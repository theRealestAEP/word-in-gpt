---
name: word-editor
description: View and edit Word .docx files in the Word editor. Use when the user wants to see, review, or change a .docx file, or when a .docx file is open in the Word editor.
---

# Word editor

The Word editor shows a .docx file with Word page layout. The user and you edit the same open document. Host-managed files autosave. Uploaded attachments are edited copies: use **Download DOCX** to keep the result.

## Show a document

1. In ChatGPT web or mobile, attach a DOCX and call `open_word_document` with ChatGPT's file object: `download_url`, `file_id`, and optional `file_name` and `mime_type`. Copy these values from the attachment. With the locally installed plugin, its opener instead accepts `{"file":{"name":"report.docx","resourceUri":"file:///absolute/path/report.docx"}}`. Host file viewers use `open_word_resource` with the granted resource URI.
2. Check the editor panel or its model context to confirm that the file opened. The panel shows the file name, save status, and chat connection status. `open_in_codex` is also available, but its `queued` acknowledgement alone does not confirm that the host launched the editor.
3. An absolute file link is useful for locating the document, but the host can route attachment and review links to its built-in document preview. That preview supports annotations; the Word editor has an editing toolbar.

If tools or editor context are unavailable, inspect the existing Word panel through the `mcpapps` browser backend when available. Report its actual connection status. The local mock host tests the editor bridge separately and saves changes in memory. Its success does not verify a live Codex session.

## Edit the open document

The MCP server advertises `word_document_*`. They run against the open editor through its live connection. Each call requires the `editorSessionId` returned by the opening tool. Preserve this private identifier; use the ID for the intended file. Confirm opening with `word_document_inspect` using that ID. The editor keeps that ID when reconnecting. Opening another document supplies its own ID.

Choose the path from the request:

- **Wording edits:** call `word_document_project` in `text` mode, then `word_document_patch` with the changed line ranges and the projection's revision. These two calls are the complete content path. Text mode is the default and returns compact line references. Keep the same story, cursor, and window limits on the patch. Existing styles remain in place.
- **Formatting or layout edits:** inspect the document, then call the individual edit tool using the observed revision and references. For example, `word_document_format_paragraph` sets paragraph alignment or style. Each tool publishes its own input schema. `inspect` with `kind: "read"` returns detailed formatting; `context` returns compact text across stories. Request spatial information only for page geometry tasks.
- **Heading or list structure edits:** explicitly use `md` mode with project and patch, or the relevant detailed edit operation. Markdown markers can change those structures.

When a result reports `needs_sync`, or asks you to inspect again, refresh the text projection or inspection before the next edit.

Do not save the file yourself. Do not write to the .docx file with other tools while it is open in the editor, because the user can have unsaved edits there.

After an edit, report the returned save status. Uploaded copies remain in the editor until the user chooses **Download DOCX**. A host-managed file reports **Saved** after its write succeeds. Confirm text and formatting in the exported or reopened DOCX when verifying the result.

## Requests that use another service

Email delivery uses an email service or the user's mail app. Software purchases use the vendor's checkout. Drive account searches use a connected Drive service. Explain which service the request needs. Word in Chat opens, inspects, edits, and exports the selected DOCX.

## Work with highlighted text

On mobile, the user can turn on **Select text**, drag across a passage, and tap **Add to chat**. When active, the button says **Selection on**. Tap **Selection on** to resume scrolling. The user can also highlight text and click **Add to chat**, or right-click the selection and choose **Add to chat**, the first menu item. The editor adds the selected text, revision, and exact run ranges to model context. Use these ranges when the user says "this section" or "the highlighted text." For wording changes, refresh the text projection and use its compact block references to locate the selected paragraph. Change only the selected text within that line. For detailed operations, inspect the selected references before editing. The library reports up to 64 text ranges. If the context reports `possiblyTruncated: true`, inspect the surrounding section and establish the full selection before a bulk rewrite.
