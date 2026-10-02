// Exercise the distributed stdio server with a headless editor adapter.
// Native Codex panel verification is a separate release check.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AgentDocument } from "@wordinweb/agent";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "word-package-"));
const client = new Client({ name: "local-package-check", version: "1" });
const fixture = join(root, "publication/fixtures/review.docx");
const original = await readFile(fixture);

try {
  const installation = join(temporary, "plugin");
  const documentPath = join(temporary, "review.docx");
  await cp(join(root, "plugin"), installation, { recursive: true });
  await cp(fixture, documentPath);
  const config = JSON.parse(await readFile(join(installation, ".mcp.json"), "utf8"));
  const server = config.mcpServers["word-in-gpt"];
  await client.connect(new StdioClientTransport({
    command: server.command, args: server.args, cwd: installation,
  }));

  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  }

  const { tools } = await client.listTools();
  assert.equal(tools.filter(tool => tool.name.startsWith("word_document_")).length, 5);
  for (const tool of tools) {
    for (const key of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
      assert.equal(typeof tool.annotations?.[key], "boolean", `${tool.name}: ${key}`);
    }
  }
  const opener = tools.find(tool => tool.name === "open_word_document");
  const resource = await client.readResource({ uri: opener._meta.ui.resourceUri });
  assert.ok(resource.contents[0].text.includes("word_editor_connect"));
  const opened = await call("open_word_document", { file: {
    name: "review.docx", resourceUri: pathToFileURL(documentPath).href,
  } });
  assert.match(opened.file.resourceUri, /^word-local:\/\//);
  const { editorSessionId } = opened;
  assert.deepEqual(await call("word_editor_connect", { editorSessionId }), { editorSessionId });
  const snapshot = await call("word_local_read", { uri: opened.file.resourceUri });
  const doc = AgentDocument.load(Buffer.from(snapshot.blob, "base64"));

  async function documentCall(name, args) {
    const pending = client.callTool({ name, arguments: { editorSessionId, ...args } });
    const { command } = await call("word_editor_poll", { editorSessionId });
    assert.equal(command.name, name);
    assert.deepEqual(command.arguments, args);
    const result = await doc.tools().find(tool => tool.name === name).execute(command.arguments);
    await call("word_editor_reply", { editorSessionId, commandId: command.id,
      result: { content: [{ type: "text", text: JSON.stringify(result) }] },
    });
    const response = await pending;
    assert.equal(response.isError ?? false, false);
    return JSON.parse(response.content[0].text);
  }

  const context = await documentCall("word_document_inspect", { kind: "context" });
  const paragraphs = context.contents.find(story => story.story === "body").blocks;
  assert.deepEqual(paragraphs.map(block => block.text), ["Quarterly review", "Revenue increased this quarter."]);
  await documentCall("word_document_capabilities", { kind: "insertText" });
  const first = paragraphs.find(block => block.text.trim());
  await documentCall("word_document_edit", { revision: context.revision, operations: [{
    kind: "insertText", at: { blockRef: first.ref, runRef: first.runs[0].ref, offset: 0 },
    text: "[Review passed] ",
  }] });
  const saved = await call("word_local_write", {
    uri: opened.file.resourceUri, blob: Buffer.from(doc.save()).toString("base64"), ifMatch: snapshot.etag,
  });
  assert.equal(saved.outcome, "saved");
  const reopened = AgentDocument.load(await readFile(documentPath));
  const final = await reopened.inspect({ kind: "context" });
  assert.deepEqual(final.contents[0].blocks.map(block => block.text), [
    "[Review passed] Quarterly review", "Revenue increased this quarter.",
  ]);
  const conflict = await call("word_local_write", {
    uri: opened.file.resourceUri, blob: snapshot.blob, ifMatch: snapshot.etag,
  });
  assert.equal(conflict.outcome, "conflict");
  assert.deepEqual(await readFile(fixture), original);
  await call("word_editor_disconnect", { editorSessionId });
  console.log("Local package passed: isolated startup, five document tools, annotations, UI resource, file launch, session routing, edit, saved DOCX, conflict detection, and unchanged fixture. Native panel verification remains separate.");
} finally {
  await client.close();
  await rm(temporary, { recursive: true, force: true });
}
