import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it, vi } from "vitest";
import worker, { ExportCopies, WordEditorRelay } from "./worker.ts";
import { fetchOpenAIFile } from "./server.ts";
import { toolsListResult } from "./tools-list.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("streams fallback bytes before the source finishes and expires its private link", async () => {
  vi.useFakeTimers();
  const relay = new WordEditorRelay({ getWebSockets: () => [] } as never, {
    ASSETS: { fetch: async () => new Response("<html>Editor</html>") },
  } as never);
  const client = new Client({ name: "stream-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://worker.example/mcp"), {
    fetch: (input, init) => relay.fetch(new Request(input, init)),
  }));
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    source = controller;
    controller.enqueue(new Uint8Array([80, 75]));
  } });
  const fetchSource = vi.fn().mockResolvedValue(new Response(body));
  vi.stubGlobal("fetch", fetchSource);
  try {
    const fallback = await client.callTool({ name: "word_attachment_read", arguments: {
      downloadUrl: "https://oaisdmntprcentralus.blob.core.windows.net/review.docx",
    } });
    expect(fetchSource).not.toHaveBeenCalled();
    const link = fallback._meta!.fileDownloadUrl as string;
    expect(fallback._meta!.fileBlob).toBeUndefined();
    expect(JSON.stringify(fallback.structuredContent)).not.toContain(link);
    const response = await relay.fetch(new Request(link));
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const reader = response.body!.getReader();
    expect(await reader.read()).toEqual({ value: new Uint8Array([80, 75]), done: false });
    source.enqueue(new Uint8Array([3, 4]));
    source.close();
    expect(await reader.read()).toEqual({ value: new Uint8Array([3, 4]), done: false });
    expect((await reader.read()).done).toBe(true);
    expect(fetchSource).toHaveBeenCalledWith("https://oaisdmntprcentralus.blob.core.windows.net/review.docx", { redirect: "manual" });
    expect((await relay.fetch(new Request("https://worker.example/attachments/other"))).status).toBe(404);
    await vi.advanceTimersByTimeAsync(90_000);
    expect((await relay.fetch(new Request(link))).status).toBe(404);
  } finally { await client.close(); }
});

it("restores socket sessions after hibernation and routes replies only to their own command", async () => {
  const id = crypto.randomUUID(), otherId = crypto.randomUUID();
  const socket = { readyState: WebSocket.OPEN, deserializeAttachment: () => ({ editorSessionId: id }), send: vi.fn(), close: vi.fn() };
  const other = { readyState: WebSocket.OPEN, deserializeAttachment: () => ({ editorSessionId: otherId }), send: vi.fn(), close: vi.fn() };
  const closing = { readyState: WebSocket.CLOSING, deserializeAttachment: () => ({ editorSessionId: id }), send: vi.fn(), close: vi.fn() };
  // A fresh constructor receives only Cloudflare's persisted socket attachments.
  const relay = new WordEditorRelay({ getWebSockets: () => [socket, other, closing] } as never, {
    ASSETS: { fetch: async () => new Response("<html>Editor</html>") },
  } as never);
  const client = new Client({ name: "socket-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://worker.example/mcp"), {
    fetch: (input, init) => relay.fetch(new Request(input, init)),
  }));
  try {
    const response = client.callTool({ name: "word_document_inspect", arguments: { editorSessionId: id, kind: "context" } });
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
    expect(other.send).not.toHaveBeenCalled();
    expect(closing.send).not.toHaveBeenCalled();
    const { command } = JSON.parse(socket.send.mock.calls[0][0]);
    const result = { content: [{ type: "text", text: "restored document" }] };
    relay.webSocketMessage(other as never, JSON.stringify({ commandId: command.id, result }));
    expect(other.close).toHaveBeenCalledWith(1008, "Invalid or expired editor reply");
    relay.webSocketMessage(socket as never, JSON.stringify({ commandId: command.id, result }));
    expect((await response).content).toEqual(result.content);
    relay.webSocketClose(socket as never);
    const closed = await client.callTool({ name: "word_document_inspect", arguments: { editorSessionId: id, kind: "context" } });
    expect(closed.isError).toBe(true);
    relay.webSocketClose(other as never);
  } finally { await client.close(); }
});

it("requires a WebSocket upgrade and a valid private session before accepting a socket", async () => {
  const relay = new WordEditorRelay({ getWebSockets: () => [] } as never, {
    ASSETS: { fetch: async () => new Response("<html>Editor</html>") },
  } as never);
  expect((await relay.fetch(new Request("https://worker.example/editor/unknown"))).status).toBe(426);
  expect((await relay.fetch(new Request("https://worker.example/editor/unknown", { headers: { Upgrade: "websocket" } }))).status).toBe(404);
});

it("refuses to relay hosts outside OpenAI file storage", async () => {
  const relay = new WordEditorRelay({ getWebSockets: () => [] } as never, {
    ASSETS: { fetch: async () => new Response("<html>Editor</html>") },
  } as never);
  const client = new Client({ name: "relay-host-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://worker.example/mcp"), {
    fetch: (input, init) => relay.fetch(new Request(input, init)),
  }));
  try {
    for (const downloadUrl of ["https://example.com/", "https://attacker.blob.core.windows.net/page.html", "http://oaisdmntprcentralus.blob.core.windows.net/a"]) {
      const refused = await client.callTool({ name: "word_attachment_read", arguments: { downloadUrl } });
      expect(refused.isError).toBe(true);
    }
  } finally { await client.close(); }
});

it("hands an exported copy out once as a download and refuses oversized copies", async () => {
  const relay = new ExportCopies();
  const bytes = new Uint8Array([80, 75, 3, 4]);
  const made = await relay.fetch(new Request("https://worker.example/exports?name=Q3%20review.docx", { method: "POST", body: bytes }));
  expect(made.headers.get("Access-Control-Allow-Origin")).toBe("*");
  const { url } = await made.json() as { url: string };
  expect(url).toMatch(/^https:\/\/worker\.example\/exports\/[0-9a-f-]{36}$/);

  const downloaded = await relay.fetch(new Request(url));
  expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  expect(downloaded.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''Q3%20review.docx");
  expect(downloaded.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(downloaded.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect((await relay.fetch(new Request(url))).status).toBe(404);

  const tooBig = await relay.fetch(new Request("https://worker.example/exports", { method: "POST", body: new Uint8Array(21 * 1024 * 1024) }));
  expect(tooBig.status).toBe(413);
  expect((await relay.fetch(new Request("https://worker.example/exports", { method: "OPTIONS" }))).status).toBe(200);
});

it("follows redirects only to OpenAI file storage and never relays a page", async () => {
  const fetchSource = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: "https://example.com/" } }));
  vi.stubGlobal("fetch", fetchSource);
  try {
    await expect(fetchOpenAIFile("https://oaisdmntprcentralus.blob.core.windows.net/a")).rejects.toThrow();
    expect(fetchSource).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});

it("answers 429 before the relay when a caller exceeds its rate limit", async () => {
  const relay = vi.fn();
  const blocked = { limit: vi.fn().mockResolvedValue({ success: false }) };
  const env = { MCP_LIMIT: blocked, BROWSER_LIMIT: blocked, EDITOR_RELAY: { idFromName: () => "id", get: () => ({ fetch: relay }) } } as never;
  for (const path of ["/mcp", "/attachments/token", "/editor/id"]) {
    const response = await worker.fetch(new Request(`https://worker.example${path}`, { headers: { "CF-Connecting-IP": "203.0.113.9" } }), env, { waitUntil: vi.fn() } as never);
    expect(response.status).toBe(429);
  }
  expect(relay).not.toHaveBeenCalled();
  expect(blocked.limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
  expect(blocked.limit).toHaveBeenCalledWith({ key: "editor:203.0.113.9" });
});

it("answers 503 and logs only the cause when the Durable Object connection drops", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const lost = Object.assign(new Error("Network connection lost."), { retryable: true });
  const allow = { limit: vi.fn().mockResolvedValue({ success: true }) };
  const put = vi.fn().mockResolvedValue(undefined);
  const waitUntil = vi.fn();
  const env = { MCP_LIMIT: allow, BROWSER_LIMIT: allow, ERROR_LOG: { put }, EDITOR_RELAY: { idFromName: () => "id", get: () => ({ fetch: vi.fn().mockRejectedValue(lost) }) } } as never;
  const sessionId = crypto.randomUUID();
  const response = await worker.fetch(new Request(`https://worker.example/editor/${sessionId}`, { headers: { "CF-Connecting-IP": "203.0.113.9" } }), env, { waitUntil } as never);
  expect(response.status).toBe(503);
  expect(errors).toHaveBeenCalledTimes(1);
  const summary = { relayError: "relay", route: "editor", name: "Error", message: "Network connection lost.", retryable: true };
  expect(JSON.parse(String(errors.mock.calls[0][0]))).toEqual(summary);
  // The record goes to KV after the response, expires after 30 days, and lists with its cause.
  expect(waitUntil).toHaveBeenCalledTimes(1);
  const [key, value, options] = put.mock.calls[0];
  expect(key).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(options).toEqual({ metadata: summary, expirationTtl: 2_592_000 });
  expect(JSON.parse(value)).toMatchObject({ ...summary, stack: expect.stringContaining("Network connection lost.") });
  for (const stored of [String(errors.mock.calls[0][0]), value, JSON.stringify(options)]) {
    expect(stored).not.toContain(sessionId);
    expect(stored).not.toContain("203.0.113.9");
  }
});

it("lets requests through when the rate limiter itself fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const relay = vi.fn().mockResolvedValue(new Response("ok"));
  const broken = { limit: vi.fn().mockRejectedValue(new Error("limiter unavailable")) };
  const env = { MCP_LIMIT: broken, BROWSER_LIMIT: broken, ERROR_LOG: { put: vi.fn().mockResolvedValue(undefined) }, EDITOR_RELAY: { idFromName: () => "id", get: () => ({ fetch: relay }) } } as never;
  const response = await worker.fetch(new Request("https://worker.example/mcp", { method: "POST" }), env, { waitUntil: vi.fn() } as never);
  expect(response.status).toBe(200);
  expect(relay).toHaveBeenCalledTimes(1);
});

function pollingEnv(assets: Record<string, string>) {
  const relay = vi.fn().mockResolvedValue(new Response("relay"));
  const allow = { limit: vi.fn().mockResolvedValue({ success: true }) };
  const env = {
    MCP_LIMIT: allow, BROWSER_LIMIT: allow, ERROR_LOG: { put: vi.fn().mockResolvedValue(undefined) },
    USAGE: { writeDataPoint: vi.fn() }, USAGE_SALT: "",
    ASSETS: { fetch: async (url: string) => url.split("/").pop()! in assets ? new Response(assets[url.split("/").pop()!]) : new Response(null, { status: 404 }) },
    EDITOR_RELAY: { idFromName: () => "id", get: () => ({ fetch: relay }) },
  } as never;
  return { env, relay };
}

function rpc(method: string, id?: number) {
  return new Request("https://worker.example/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params: method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } } : {} }),
  });
}

it("answers Codex's polling in the Worker with the same tool list the server builds", async () => {
  const toolsList = await toolsListResult();
  const { env, relay } = pollingEnv({ "tools-list.json": toolsList, "icon.svg": "<svg/>" });
  const ctx = { waitUntil: vi.fn() } as never;
  const listed = await worker.fetch(rpc("tools/list", 7), env, ctx);
  expect(await listed.json()).toEqual({ jsonrpc: "2.0", id: 7, result: JSON.parse(toolsList) });
  const initialized = await worker.fetch(rpc("initialize", 1), env, ctx);
  expect(await initialized.json()).toMatchObject({ id: 1, result: { serverInfo: { name: "word-in-gpt" } } });
  expect((await worker.fetch(rpc("notifications/initialized"), env, ctx)).status).toBe(202);
  expect((await worker.fetch(new Request("https://worker.example/mcp", { headers: { Accept: "*/*" } }), env, ctx)).status).toBe(406);
  expect(relay).not.toHaveBeenCalled();
  // Tool calls need the editor session, so they still go to the relay.
  await worker.fetch(rpc("tools/call", 2), env, ctx);
  expect(relay).toHaveBeenCalledTimes(1);
});

it("serves the editor from the current deploy's assets, not from the relay's older copy", async () => {
  const { env, relay } = pollingEnv({ "app.html": "<html>New editor</html>", "icon.svg": "<svg/>" });
  const read = new Request("https://worker.example/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "ui://word-in-gpt/editor-v19" } }),
  });
  const response = await worker.fetch(read, env, { waitUntil: vi.fn() } as never);
  expect(await response.json()).toMatchObject({ id: 5, result: { contents: [{ uri: "ui://word-in-gpt/editor-v19", text: "<html>New editor</html>" }] } });
  expect(relay).not.toHaveBeenCalled();
});

it("sends tools/list to the relay when the built list is missing", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { env, relay } = pollingEnv({ "icon.svg": "<svg/>" });
  // A fresh module: the built list is cached per Worker instance.
  vi.resetModules();
  const { default: freshWorker } = await import("./worker.ts");
  const response = await freshWorker.fetch(rpc("tools/list", 3), env, { waitUntil: vi.fn() } as never);
  expect(await response.text()).toBe("relay");
  expect(relay).toHaveBeenCalledTimes(1);
});
