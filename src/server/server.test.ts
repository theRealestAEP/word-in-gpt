import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createServer } from "./server.ts";
import { LocalFiles } from "./local-files.ts";
import { EDIT_TOOLS } from "./edit-tools.ts";
import { AgentDocument, agentCapabilities, type AgentContextResult } from "@wordinweb/agent";

it("serves the current editor at previously published template URIs", async () => {
  const html = "<html>Current Word editor</html>";
  const server = createServer(html, "<svg/>");
  const client = new Client({ name: "cached-template-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const { tools } = await client.listTools();
    const currentUri = (tools.find(t => t.name === "open_word_document")!._meta!.ui as { resourceUri: string }).resourceUri;
    for (const uri of [currentUri, "ui://word-in-gpt/editor-v7", "ui://word-in-gpt/editor-v6", "ui://word-in-gpt/editor-v5"]) {
      const resource = await client.readResource({ uri });
      expect(resource.contents).toEqual([expect.objectContaining({ uri, mimeType: "text/html;profile=mcp-app", text: html })]);
    }
  } finally { await client.close(); await server.close(); }
});

it("advertises model tools and routes calls through the app-only connection", async () => {
  const server = createServer("<html>Word</html>", "<svg/>");
  const client = new Client({ name: "integration-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const { tools } = await client.listTools();
    expect(tools.filter(t => t.name.startsWith("word_document_"))).toHaveLength(4 + EDIT_TOOLS.length);
    expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length);
    expect(new Set(tools.map(tool => tool.title ?? tool.name)).size).toBe(tools.length);
    expect(tools.some(tool => tool.name === "word_document_edit")).toBe(false);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }
    for (const name of ["word_document_patch", ...EDIT_TOOLS.map(tool => tool.name)]) {
      expect(tools.find(t => t.name === name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(tools.find(t => t.name === "word_editor_connect")?._meta?.ui).toMatchObject({ visibility: ["app"] });
    // OpenAI's schema requires the leading dot; without it the host ignores the file handler.
    expect(tools.find(t => t.name === "open_word_resource")?._meta?.["openai/ui"]).toMatchObject({ entrypoints: [{ type: "file", extensions: [".docx"] }] });
    expect(tools.some(t => t.name.startsWith("word_local_"))).toBe(false);
    const local = await client.callTool({ name: "open_word_document", arguments: { file: { name: "test.docx", resourceUri: "file:///tmp/test.docx" } } });
    expect(local.isError).toBe(true);
    const staleUpload = await client.callTool({ name: "open_word_resource", arguments: { file: { name: "review.docx", resourceUri: "word-upload://file_review" } } });
    expect(staleUpload.isError).toBe(true);
    expect(staleUpload.content).toEqual([{ type: "text", text: expect.stringContaining("original ChatGPT file parameters") }]);
    const connected = await client.callTool({ name: "word_editor_connect", arguments: {} });
    const { editorSessionId } = connected.structuredContent as { editorSessionId: string };
    const inspection = client.callTool({ name: "word_document_inspect", arguments: { editorSessionId, kind: "context" } });
    const poll = await client.callTool({ name: "word_editor_poll", arguments: { editorSessionId } });
    const { command } = poll.structuredContent as { command: { id: string; arguments: unknown } };
    expect(command.arguments).toEqual({ kind: "context" });
    await client.callTool({ name: "word_editor_reply", arguments: { editorSessionId, commandId: command.id, result: { content: [{ type: "text", text: "live inspection" }] } } });
    expect((await inspection).content).toEqual([{ type: "text", text: "live inspection" }]);
    await client.callTool({ name: "word_editor_disconnect", arguments: { editorSessionId } });
  } finally { await client.close(); await server.close(); }
});

it("exposes every edit upfront and routes individual edits to the live document", async () => {
  const kinds = new Set(EDIT_TOOLS.map(tool => tool.operation({}).kind));
  expect(kinds).toEqual(new Set(agentCapabilities().map(tool => tool.kind)));
  expect(EDIT_TOOLS.filter(tool => tool.operation({}).kind === "tableOp")).toHaveLength(13);
  const server = createServer("<html>Word</html>", "<svg/>");
  const client = new Client({ name: "individual-edit-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const doc = AgentDocument.load(await readFile(new URL("../../publication/fixtures/review.docx", import.meta.url)));
  try {
    const connected = await client.callTool({ name: "word_editor_connect", arguments: {} });
    const { editorSessionId } = connected.structuredContent as { editorSessionId: string };
    const context = await doc.inspect({ kind: "context" }) as AgentContextResult;
    const blockRef = context.contents[0].blocks[0].ref;
    const pending = client.callTool({ name: "word_document_format_paragraph", arguments: {
      editorSessionId, revision: context.revision, blockRef, align: "center",
    } });
    const poll = await client.callTool({ name: "word_editor_poll", arguments: { editorSessionId } });
    const { command } = poll.structuredContent as { command: { id: string; name: string; arguments: object } };
    expect(command.name).toBe("word_document_edit");
    expect(command.arguments).toEqual({ revision: context.revision, operations: [{ kind: "formatParagraph", blockRef, align: "center" }] });
    const result = await doc.tools().find(tool => tool.name === command.name)!.execute(command.arguments);
    await client.callTool({ name: "word_editor_reply", arguments: { editorSessionId, commandId: command.id,
      result: { content: [{ type: "text", text: JSON.stringify(result) }] },
    } });
    expect((await pending).isError).not.toBe(true);
    const read = await doc.inspect({ kind: "read", story: "body" });
    expect(read).toMatchObject({ blocks: expect.arrayContaining([expect.objectContaining({
      text: "Quarterly review", alignment: "center", styleId: "Heading1",
    })]) });
    const invalid = await client.callTool({ name: "word_document_format_paragraph", arguments: {
      editorSessionId, revision: context.revision, blockRef, align: "invalid",
    } });
    expect(invalid.isError).toBe(true);
    const table = EDIT_TOOLS.find(tool => tool.name === "word_document_table_cell_shading")!;
    expect(table.operation({ cellRef: "block:2", fill: "#FFFFFF" })).toEqual({
      kind: "tableOp", cellRef: "block:2", op: { kind: "cellShading", fill: "#FFFFFF" },
    });
    expect(table.inputSchema.safeParse({ revision: "1", cellRef: "block:2", fill: "invalid" }).success).toBe(false);
    await client.callTool({ name: "word_editor_disconnect", arguments: { editorSessionId } });
  } finally { await client.close(); await server.close(); }
});

it("passes the private download URL without fetching bytes and provides an app-only fallback", async () => {
  const fixture = await readFile(new URL("../../publication/fixtures/review.docx", import.meta.url));
  const fetchFile = vi.fn().mockResolvedValue(new Response(fixture));
  vi.stubGlobal("fetch", fetchFile);
  const server = createServer("<html>Word</html>", "<svg/>");
  const client = new Client({ name: "chatgpt-upload-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const { tools } = await client.listTools();
    const opener = tools.find(tool => tool.name === "open_word_document")!;
    expect(opener.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(opener._meta?.["openai/fileParams"]).toEqual(["file"]);
    const fileSchema = (opener.inputSchema.properties!.file as { required: string[]; properties: object });
    expect(fileSchema.required).toEqual(["download_url", "file_id"]);
    expect(Object.keys(fileSchema.properties)).toEqual(["download_url", "file_id", "mime_type", "file_name"]);
    const opened = await client.callTool({ name: "open_word_document", arguments: { file: {
      download_url: "https://oaisdmntprcentralus.blob.core.windows.net/review.docx", file_id: "file_review", file_name: "review.docx",
    } } });
    expect(opened.isError).not.toBe(true);
    expect(opened.structuredContent).toEqual({ file: { name: "review.docx", resourceUri: "word-upload://file_review" }, editorSessionId: expect.any(String) });
    expect(opened._meta).toEqual({ fileDownloadUrl: "https://oaisdmntprcentralus.blob.core.windows.net/review.docx" });
    expect(JSON.stringify(opened.structuredContent)).not.toContain(fixture.toString("base64"));
    expect(JSON.stringify(opened.content)).not.toContain("https://oaisdmntprcentralus.blob.core.windows.net");
    expect(JSON.stringify(opened.structuredContent)).not.toContain("https://oaisdmntprcentralus.blob.core.windows.net");
    expect(fetchFile).not.toHaveBeenCalled();
    const fallback = tools.find(tool => tool.name === "word_attachment_read")!;
    expect(fallback._meta?.ui).toMatchObject({ visibility: ["app"] });
    expect(fallback.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const downloaded = await client.callTool({ name: "word_attachment_read", arguments: { downloadUrl: "https://oaisdmntprcentralus.blob.core.windows.net/review.docx" } });
    expect(Buffer.from(downloaded._meta!.fileBlob as string, "base64")).toEqual(fixture);
    expect(JSON.stringify(downloaded.content)).not.toContain(fixture.toString("base64"));
    expect(fetchFile).toHaveBeenCalledWith("https://oaisdmntprcentralus.blob.core.windows.net/review.docx", { redirect: "manual" });
    const { editorSessionId } = opened.structuredContent as { editorSessionId: string };
    const inspection = client.callTool({ name: "word_document_inspect", arguments: { editorSessionId, kind: "context" } });
    const connected = await client.callTool({ name: "word_editor_connect", arguments: { editorSessionId } });
    expect(connected.structuredContent).toEqual({ editorSessionId });
    const poll = await client.callTool({ name: "word_editor_poll", arguments: { editorSessionId } });
    const { command } = poll.structuredContent as { command: { id: string; name: string } };
    expect(command.name).toBe("word_document_inspect");
    await client.callTool({ name: "word_editor_reply", arguments: { editorSessionId, commandId: command.id, result: { content: [{ type: "text", text: "document loaded" }] } } });
    expect((await inspection).content).toEqual([{ type: "text", text: "document loaded" }]);
    await client.callTool({ name: "word_editor_disconnect", arguments: { editorSessionId } });
    fetchFile.mockResolvedValue(new Response("expired", { status: 403 }));
    const expired = await client.callTool({ name: "word_attachment_read", arguments: { downloadUrl: "https://oaisdmntprcentralus.blob.core.windows.net/expired" } });
    expect(expired.isError).toBe(true);
    expect(expired.content).toEqual([{ type: "text", text: expect.stringContaining("Attach the DOCX again") }]);
  } finally { await client.close(); await server.close(); vi.unstubAllGlobals(); }
});

it("launches an explicit local file and gives the UI and model the same session", async () => {
  const server = createServer("<html>Word</html>", "<svg/>", new LocalFiles());
  const client = new Client({ name: "local-launch-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const opened = await client.callTool({ name: "open_word_document", arguments: { file: {
      name: "sample.docx", resourceUri: new URL("../../dev/sample.docx", import.meta.url).href,
    } } });
    const { file, editorSessionId } = opened.structuredContent as { file: { resourceUri: string }; editorSessionId: string };
    expect(file.resourceUri).toMatch(/^word-local:\/\//);
    const connected = await client.callTool({ name: "word_editor_connect", arguments: { editorSessionId } });
    expect(connected.structuredContent).toEqual({ editorSessionId });
    const read = await client.callTool({ name: "word_local_read", arguments: { uri: file.resourceUri } });
    expect(Buffer.from((read.structuredContent as { blob: string }).blob, "base64").subarray(0, 2).toString()).toBe("PK");
    await client.callTool({ name: "word_editor_disconnect", arguments: { editorSessionId } });
  } finally { await client.close(); await server.close(); }
});
