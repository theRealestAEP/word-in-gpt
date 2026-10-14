---
name: wordinweb-documents
description: Read and edit DOCX documents open in Word in Chat, including text, formatting, tables, page layout, and comments.
---

# Edit the open document

Use this skill for document operations in the Word in Chat editor. Use the
`word-editor` skill to open a DOCX and work with highlighted text.

Every document tool call requires the `editorSessionId` returned by the opening
tool. Use the session for the intended file. When the editor
reconnects, keep the same session ID. Opening another document supplies its own ID.

## Choose the editing path

- For wording changes, call `word_document_project` in `text` mode, then
  `word_document_patch` with the returned revision and changed line ranges.
  Keep the same story and projection window. Existing styles remain in place.
- For formatting, tables, page layout, or comments, inspect the target with
  `word_document_inspect`, then call its individual edit tool, such as
  `word_document_format_paragraph` or `word_document_comment_run`. Each tool
  exposes its own operation fields, revision, and editorSessionId.
- For heading or list structure changes, use `md` mode explicitly with project
  and patch, or use the relevant structured operation.

Read [references/inspect-edit.md](references/inspect-edit.md) for inspection,
text patches, and individual edits. Read
[references/interface.md](references/interface.md) for operation fields and
reference types. Use each runtime tool schema as the authority for a call.

## Keep edits scoped

1. Locate the requested text or object in the current document.
2. Use the revision and references returned by the latest relevant read.
3. Apply related changes in one bounded call.
4. Refresh the projection or inspection after a stale-revision error.
5. Re-inspect after structural changes before using new references.
6. Check the affected text, formatting, or page geometry.
7. Confirm the returned save status. Host-managed files show Saved. Uploaded attachments show Edited copy ready to download; the user chooses Download DOCX to export the result.

Use compact text projections for prose. Request detailed formatting or spatial
inspection when the requested edit needs it. Preserve content and formatting
outside the user's requested change.
