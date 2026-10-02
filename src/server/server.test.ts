import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createServer } from "./server.ts";
import { LocalFiles } from "./local-files.ts";

it("advertises model tools and routes calls through the app-only connection", async () => {
  const server = createServer("<html>Word</html>", "<svg/>");
  const client = new Client({ name: "integration-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const { tools } = await client.listTools();
    expect(tools.filter(t => t.name.startsWith("word_document_"))).toHaveLength(5);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }
    for (const name of ["word_document_edit", "word_document_patch"]) {
      expect(tools.find(t => t.name === name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(tools.find(t => t.name === "word_editor_connect")?._meta?.ui).toMatchObject({ visibility: ["app"] });
    expect(tools.some(t => t.name.startsWith("word_local_"))).toBe(false);
    const local = await client.callTool({ name: "open_word_document", arguments: { file: { name: "test.docx", resourceUri: "file:///tmp/test.docx" } } });
    expect(local.isError).toBe(true);
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
