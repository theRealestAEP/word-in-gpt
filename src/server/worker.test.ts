import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it, vi } from "vitest";
import worker, { ExportCopies, WordEditorRelay } from "./worker.ts";
import { fetchOpenAIFile } from "./server.ts";
import { toolsListResult } from "./tools-list.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

// The Worker tells each relay its name.
function named(request: Request, name: string) {
  const forwarded = new Request(request);
  forwarded.headers.set("X-Relay-Name", name);
  return forwarded;
}

it("streams fallback bytes before the source finishes and expires its private link", async () => {
  vi.useFakeTimers();
  const relay = new WordEditorRelay({ getWebSockets: () => [] } as never);
  const client = new Client({ name: "stream-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://worker.example/mcp"), {
    fetch: (input, init) => relay.fetch(named(new Request(input, init), "relay-name")),
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
    expect(link).toBe("https://worker.example/attachments/relay-name");
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
  const relay = new WordEditorRelay({ getWebSockets: () => [socket, other, closing] } as never);
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
  const relay = new WordEditorRelay({ getWebSockets: () => [] } as never);
  expect((await relay.fetch(new Request("https://worker.example/editor/unknown"))).status).toBe(426);
  expect((await relay.fetch(new Request("https://worker.example/editor/unknown", { headers: { Upgrade: "websocket" } }))).status).toBe(404);
});

it("refuses to relay hosts outside OpenAI file storage", async () => {
  const relay = new WordEditorRelay({ getWebSockets: () => [] } as never);
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
  expect(waitUntil).toHaveBeenCalledTimes(2);
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

it("refuses a file URL in the Worker with the current text, and relays every other open", async () => {
  const { env, relay } = pollingEnv({ "icon.svg": "<svg/>" });
  const open = (resourceUri: string) => new Request("https://worker.example/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "open_word_resource", arguments: { file: { name: "a.docx", resourceUri } } } }),
  });
  const ctx = { waitUntil: vi.fn() } as never;
  const refused = await worker.fetch(open("file:///Users/me/a.docx"), env, ctx);
  expect(await refused.json()).toMatchObject({ id: 6, result: { isError: true, content: [{ text: expect.stringContaining(`{"file":"/Users/me/a.docx"}`) }] } });
  expect(relay).not.toHaveBeenCalled();
  await worker.fetch(open("codex-file://granted"), env, ctx);
  expect(relay).toHaveBeenCalledTimes(1);
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

it("tells an older editor that another editor took over its session", () => {
  const id = crypto.randomUUID();
  const older = { readyState: WebSocket.OPEN, deserializeAttachment: () => ({ editorSessionId: id }), send: vi.fn(), close: vi.fn() };
  const newer = { readyState: WebSocket.OPEN, deserializeAttachment: () => ({ editorSessionId: id }), send: vi.fn(), close: vi.fn() };
  new WordEditorRelay({ getWebSockets: () => [older, newer] } as never);
  expect(older.close).toHaveBeenCalledWith(4000, "Another editor took over");
  expect(newer.close).not.toHaveBeenCalled();
});

function toolCall(name: string, args: Record<string, unknown>) {
  return new Request("https://worker.example/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": "openai-mcp/1.0.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name, arguments: args, _meta: { "openai/subject": "user-abc" } } }),
  });
}

/** An env whose relays are real, one for each name, as Cloudflare gives them. */
function relaysEnv() {
  const relays = new Map<string, WordEditorRelay>();
  const allow = { limit: vi.fn().mockResolvedValue({ success: true }) };
  const env = {
    MCP_LIMIT: allow, BROWSER_LIMIT: allow, ERROR_LOG: { put: vi.fn().mockResolvedValue(undefined) },
    USAGE: { writeDataPoint: vi.fn() }, USAGE_SALT: "test-salt",
    ASSETS: { fetch: async () => new Response("<svg/>") },
    EDITOR_RELAY: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        if (!relays.has(name)) relays.set(name, new WordEditorRelay({ getWebSockets: () => [] } as never));
        return relays.get(name);
      },
    },
  };
  return { env: env as never, usage: env.USAGE, relays };
}

it("gives each opened document its own relay and sends later calls to that relay", async () => {
  const { env, relays } = relaysEnv();
  const ctx = { waitUntil: vi.fn() } as never;
  const open = async () => (await (await worker.fetch(toolCall("open_word_resource", { file: { name: "a.docx", resourceUri: "codex-file://granted" } }), env, ctx)).json() as { result: { structuredContent: { editorSessionId: string } } }).result.structuredContent.editorSessionId;
  const first = await open(), second = await open();
  expect([...relays.keys()]).toEqual([first, second]);
  const connected = await worker.fetch(toolCall("word_editor_connect", { editorSessionId: first }), env, ctx);
  expect(await connected.json()).toMatchObject({ result: { structuredContent: { editorSessionId: first, webSocketUrl: `wss://worker.example/editor/${first}` } } });
  expect(relays.size).toBe(2);
  const socket = await worker.fetch(new Request(`https://worker.example/editor/${second}`), env, ctx);
  expect(socket.status).toBe(426);
  expect(relays.size).toBe(2);
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
});

it("keeps an attachment link on the relay that made it", async () => {
  const { env, relays } = relaysEnv();
  const ctx = { waitUntil: vi.fn() } as never;
  const fallback = await worker.fetch(toolCall("word_attachment_read", { downloadUrl: "https://oaisdmntprcentralus.blob.core.windows.net/a.docx" }), env, ctx);
  const link = (await fallback.json() as { result: { _meta: { fileDownloadUrl: string } } }).result._meta.fileDownloadUrl;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("docx bytes")));
  const response = await worker.fetch(new Request(link), env, ctx);
  expect(await response.text()).toBe("docx bytes");
  expect(relays.size).toBe(1);
});

it("counts failed tool calls and refused links without any error text or session ID", async () => {
  const { env, usage } = relaysEnv();
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => waited.push(promise) } as never;
  const secret = crypto.randomUUID();
  await worker.fetch(toolCall("word_document_inspect", { editorSessionId: secret, kind: "context" }), env, ctx);
  await worker.fetch(new Request(`https://worker.example/attachments/${secret}`), env, ctx);
  await Promise.all(waited);
  const blobs = usage.writeDataPoint.mock.calls.map(([point]) => point.blobs).filter(point => point[1] === "failure");
  expect(blobs).toHaveLength(2);
  expect(blobs).toContainEqual(["chatgpt", "failure", "session-closed", "word_document_inspect"]);
  expect(blobs).toContainEqual(["unknown", "failure", "status-404", "attachments"]);
  expect(JSON.stringify(usage.writeDataPoint.mock.calls)).not.toContain(secret);
});

it("counts a refused request and a lost relay", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const usage = { writeDataPoint: vi.fn() };
  const lost = { idFromName: () => "id", get: () => ({ fetch: vi.fn().mockRejectedValue(new Error("Network connection lost.")) }) };
  const allow = { limit: vi.fn().mockResolvedValue({ success: true }) };
  const blocked = { limit: vi.fn().mockResolvedValue({ success: false }) };
  const base = { USAGE: usage, USAGE_SALT: "test-salt", ERROR_LOG: { put: vi.fn().mockResolvedValue(undefined) }, EDITOR_RELAY: lost };
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => waited.push(promise) } as never;
  await worker.fetch(new Request("https://worker.example/editor/id"), { ...base, MCP_LIMIT: blocked, BROWSER_LIMIT: blocked } as never, ctx);
  await worker.fetch(new Request("https://worker.example/editor/id"), { ...base, MCP_LIMIT: allow, BROWSER_LIMIT: allow } as never, ctx);
  await Promise.all(waited);
  expect(usage.writeDataPoint.mock.calls.map(([point]) => point.blobs)).toEqual([
    ["unknown", "failure", "rate-limited", "editor"],
    ["unknown", "failure", "relay-unavailable", "editor"],
  ]);
});

it("answers 503 for the editor HTML when the Worker cannot load it, because a relay holds none", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { env, relay } = pollingEnv({ "icon.svg": "<svg/>" });
  vi.resetModules();
  const { default: freshWorker } = await import("./worker.ts");
  const read = new Request("https://worker.example/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "ui://word-in-gpt/editor-v19" } }),
  });
  const failing = { ...(env as object), ASSETS: { fetch: async (url: string) => {
    if (url.endsWith("app.html")) throw new Error("assets unavailable");
    return new Response("<svg/>");
  } } } as never;
  const response = await freshWorker.fetch(read, failing, { waitUntil: vi.fn() } as never);
  expect(response.status).toBe(503);
  expect(relay).not.toHaveBeenCalled();
});
