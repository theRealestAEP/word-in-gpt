// Exercise the deployed command socket with an actual DOCX engine.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentDocument, LocalDocumentSession } from "@wordinweb/agent";
import { liveToolHandler } from "../src/app/live-tools.ts";

const endpoint = new URL(process.argv[2] ?? "http://127.0.0.1:8787/mcp");
const idleMs = Number(process.argv[3] ?? 0);
const client = new Client({ name: "websocket-check", version: "1" });
const ids = [];
const sockets = [];
let commands = 0;
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
async function openSocket(url, handler) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  socket.addEventListener("message", async event => {
    const { command } = JSON.parse(event.data);
    commands++;
    const value = await handler(command.name, command.arguments);
    socket.send(JSON.stringify({ commandId: command.id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } }));
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket opening timed out")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket failed to open")); }, { once: true });
  });
  return socket;
}
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const bytes = new Uint8Array(await (await fetch(new URL("/review.docx", endpoint))).arrayBuffer());
  const session = new LocalDocumentSession(bytes);
  const handler = liveToolHandler(AgentDocument.connect(session));
  const connection = await call("word_editor_connect", {});
  const id = connection.editorSessionId;
  ids.push(id);
  assert.ok(connection.webSocketUrl, "The deployed relay must advertise WebSockets.");
  const socket = await openSocket(connection.webSocketUrl, handler);
  const other = await call("word_editor_connect", {});
  ids.push(other.editorSessionId);
  const otherSocket = await openSocket(other.webSocketUrl, () => { throw new Error("Command reached a different document"); });
  const context = await call("word_document_inspect", { editorSessionId: id, kind: "context" });
  assert.deepEqual(context.contents[0].blocks.map(block => block.text), ["Quarterly review", "Revenue increased this quarter."]);
  await call("word_document_format_paragraph", {
    editorSessionId: id, revision: context.revision,
    blockRef: context.contents[0].blocks[0].ref, align: "center",
  });
  const reopened = await AgentDocument.load(session.doc.save()).inspect({ kind: "read", story: "body" });
  assert.equal(reopened.blocks[0].alignment, "center");
  assert.equal(reopened.blocks[0].styleId, "Heading1");
  if (idleMs) {
    console.log(`Holding idle sockets for ${idleMs} ms without MCP polling or heartbeats…`);
    await delay(idleMs);
    await call("word_document_inspect", { editorSessionId: id, kind: "context" });
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.equal(otherSocket.readyState, WebSocket.OPEN);
  }
  const closed = new Promise(resolve => socket.addEventListener("close", resolve, { once: true }));
  socket.close();
  await closed;
  await delay(100);
  const resumed = await call("word_editor_connect", { editorSessionId: id });
  assert.equal(resumed.editorSessionId, id);
  await openSocket(resumed.webSocketUrl, handler);
  const after = await call("word_document_inspect", { editorSessionId: id, kind: "read", story: "body" });
  assert.equal(after.blocks[0].alignment, "center");
  assert.deepEqual(after.blocks.map(block => block.text), ["Quarterly review", "Revenue increased this quarter."]);
  console.log(`WebSocket check passed: ${commands} commands, real DOCX read/edit/export, session isolation, idle survival, and reconnection.`);
} finally {
  for (const socket of sockets) socket.close();
  for (const editorSessionId of ids) await client.callTool({ name: "word_editor_disconnect", arguments: { editorSessionId } });
  await client.close();
}
