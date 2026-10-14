// Check hosted MCP transport and cross-request editor sessions.
// Synthetic results verify routing; native editing has a separate release check.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.argv[2] ?? "http://127.0.0.1:8787/mcp");
const model = new Client({ name: "http-model-check", version: "1" });
const editor = new Client({ name: "http-editor-check", version: "1" });
const sessions = [];

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

try {
  const health = await fetch(new URL("/healthz", endpoint));
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok\n");
  await model.connect(new StreamableHTTPClientTransport(endpoint));
  await editor.connect(new StreamableHTTPClientTransport(endpoint));
  const { tools } = await model.listTools();
  assert.ok(tools.some(tool => tool.name === "word_document_format_paragraph"));
  assert.equal(new Set(tools.map(tool => tool.title ?? tool.name)).size, tools.length);
  assert.ok(tools.every(tool => !tool.name.startsWith("word_local_")));
  const opener = tools.find(tool => tool.name === "open_word_resource");
  const resource = await model.readResource({ uri: opener._meta.ui.resourceUri });
  assert.ok(resource.contents[0].text.includes("word_editor_connect"));
  const file = { name: "review.docx", resourceUri: "test-resource://review.docx" };
  const opened = await call(model, "open_word_resource", { file });
  assert.deepEqual(opened.file, file);
  sessions.push(opened.editorSessionId);
  const local = await model.callTool({ name: "open_word_resource", arguments: {
    file: { name: "review.docx", resourceUri: "file:///review.docx" },
  } });
  assert.equal(local.isError, true);

  const uploadUrl = "https://word-in-gpt-mcp.callerinfo.workers.dev/review.docx";
  const uploadedResult = await model.callTool({ name: "open_word_document", arguments: { file: {
    file_id: "file_http_check", file_name: "review.docx",
    download_url: uploadUrl,
  } } });
  assert.equal(uploadedResult.isError ?? false, false);
  assert.deepEqual(uploadedResult._meta, { fileDownloadUrl: uploadUrl });
  assert.ok(!JSON.stringify(uploadedResult.structuredContent).includes(uploadUrl));
  const uploaded = uploadedResult.structuredContent;
  // The fallback fetches only OpenAI file storage, so this synthetic host must be refused.
  // The unit tests cover streaming from an allowed host.
  const fallback = await editor.callTool({ name: "word_attachment_read", arguments: { downloadUrl: uploadUrl } });
  assert.equal(fallback.isError, true, "The fallback must refuse hosts outside OpenAI file storage.");
  const { editorSessionId } = uploaded;
  assert.ok(editorSessionId);
  sessions.push(editorSessionId);
  const { editorSessionId: otherSession } = await call(editor, "word_editor_connect", {});
  sessions.push(otherSession);
  assert.notEqual(editorSessionId, otherSession);
  const pending = model.callTool({ name: "word_document_inspect", arguments: {
    editorSessionId, kind: "context",
  } });
  assert.equal((await call(editor, "word_editor_connect", { editorSessionId })).editorSessionId, editorSessionId);
  const polling = call(editor, "word_editor_poll", { editorSessionId });
  const { command } = await polling;
  assert.equal(command.name, "word_document_inspect");
  assert.deepEqual(command.arguments, { kind: "context" });
  const result = { content: [{ type: "text", text: '{"testMarker":"HTTP session relay passed"}' }] };
  const wrongSession = await editor.callTool({ name: "word_editor_reply", arguments: {
    editorSessionId: otherSession, commandId: command.id, result,
  } });
  assert.equal(wrongSession.isError, true);
  await call(editor, "word_editor_reply", { editorSessionId, commandId: command.id, result });
  assert.deepEqual((await pending).content, result.content);
  console.log("HTTP check passed: health, tools, editor HTML, file URI handling, session routing, and session isolation.");
} finally {
  for (const editorSessionId of sessions) {
    await editor.callTool({ name: "word_editor_disconnect", arguments: { editorSessionId } });
  }
  await editor.close();
  await model.close();
}
