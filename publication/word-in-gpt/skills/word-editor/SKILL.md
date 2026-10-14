---
name: word-editor
description: View and edit Word .docx files in the Word editor. Use when the user wants to see, review, or change a .docx file, or when a .docx file is open in the Word editor.
---

# Word editor

The Word editor shows a .docx file with Word page layout. The user and you edit the same open document. Each edit saves to the file automatically, about one second after the change.

## Show a document

1. With the locally installed plugin, call `open_word_document` directly: `{"file":{"name":"report.docx","resourceUri":"file:///absolute/path/report.docx"}}`. Use the actual file path and URL-encode special characters. The local server grants access to that file and opens its editor. Hosted installations accept only host-granted resource URIs; use the host's file-opening flow there.
2. Check the editor panel or its model context to confirm that the file opened. The panel shows the file name, save status, and chat connection status. `open_in_codex` is also available, but its `queued` acknowledgement alone does not confirm that the host launched the editor.
3. An absolute file link is useful for locating the document, but the host can route attachment and review links to its built-in document preview. That preview supports annotations; the Word editor has an editing toolbar.

If tools or editor context are unavailable, inspect the existing Word panel through the `mcpapps` browser backend when available. Report its actual connection status. The local mock host tests the editor bridge separately and saves changes in memory. Its success does not verify a live Codex session.

## Edit the open document

The MCP server advertises `word_document_*`. They run against the open editor through its live connection. Each call requires `editorSessionId` from the Word editor's model context. Preserve this private identifier; use the ID for the intended file. If the editor reconnects, use its new ID.

Choose the path from the request:

- **Wording edits:** call `word_document_project` in `text` mode, then `word_document_patch` with the changed line ranges and the projection's revision. These two calls are the complete content path. Text mode is the default and returns compact line references. Keep the same story, cursor, and window limits on the patch. Existing styles remain in place.
- **Formatting or layout edits:** inspect the document, request the relevant operation schema with `word_document_capabilities`, then call `word_document_edit` using the observed revision and references. `inspect` with `kind: "read"` returns detailed formatting; `context` returns compact text across stories. Request spatial information only for page geometry tasks.
- **Heading or list structure edits:** explicitly use `md` mode with project and patch, or the relevant detailed edit operation. Markdown markers can change those structures.

When a result reports `needs_sync`, or asks you to inspect again, refresh the text projection or inspection before the next edit.

Do not save the file yourself. Do not write to the .docx file with other tools while it is open in the editor, because the user can have unsaved edits there.

## Work with highlighted text

The user can highlight text and click **Add to chat**, or right-click the selection and choose **Add to chat**, the first menu item. The editor adds the selected text, revision, and exact run ranges to model context. Use these ranges when the user says "this section" or "the highlighted text." For wording changes, refresh the text projection and use its compact block references to locate the selected paragraph. Change only the selected text within that line. For detailed operations, inspect the selected references before editing. The library reports up to 64 text ranges. If the context reports `possiblyTruncated: true`, inspect the surrounding section and establish the full selection before a bulk rewrite.

## Create a document or edit without the editor

When no document is open, or the task needs a new document, use the `wordinweb-documents` skill. It writes .docx files with the `@wordinweb/agent` package. Then show the result as described in "Show a document".
