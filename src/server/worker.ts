import { createServer, fetchOpenAIFile } from "./server.ts";
import { EDITOR_REPLACED, EditorSessions } from "./editor-sessions.ts";
import { recordFailure, recordFileSize, recordTiming, recordToolFailure, recordUsage, type McpMessage, type UsageEnv } from "./usage.ts";
import { respondMcp } from "./tools-list.ts";
import type { DurableObjectNamespace, DurableObjectState, ExecutionContext, Fetcher, KVNamespace, RateLimit, Request as WorkerRequest, WebSocket as WorkerWebSocket, WebSocketPair as WorkerWebSocketPair } from "@cloudflare/workers-types";
import { z } from "zod";

declare const WebSocketPair: typeof WorkerWebSocketPair;
const editorReply = z.object({
  commandId: z.string(),
  result: z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })), isError: z.boolean().optional() }),
});

interface Env extends UsageEnv {
  ASSETS: Fetcher;
  EDITOR_RELAY: DurableObjectNamespace;
  EXPORT_COPIES: DurableObjectNamespace;
  // Limits live in wrangler.jsonc. Counts are per caller IP and per Cloudflare location.
  MCP_LIMIT: RateLimit;
  BROWSER_LIMIT: RateLimit;
  ERROR_LOG: KVNamespace;
}

// The Worker names a relay after its session and tells the relay that name here.
const RELAY_NAME = "X-Relay-Name";
// A copy waits in memory, and an isolate has 128 MB for the code and every copy in it.
const MAX_EXPORT_BYTES = 60 * 1024 * 1024;

/**
 * The Codex app cancels downloads that start inside the editor, so the editor
 * sends the edited copy here and the host opens the link in the user's browser.
 * Each copy has its own object, named after its link, so a large copy never
 * blocks another user's copy. A copy lives in memory for 90 seconds, downloads
 * once, and is never logged. This is its own class because a running relay kept
 * its old code after a deploy, and the copies should not share the relay's memory.
 */
export class ExportCopies {
  private copy?: { bytes: ArrayBuffer; name: string };

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Cache-Control": "no-store" };
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (request.method === "GET" && url.pathname.startsWith("/exports/")) {
      const copy = this.copy;
      if (!copy) return new Response(null, { status: 404 });
      this.copy = undefined;
      return new Response(copy.bytes, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(copy.name)}`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    }
    if (request.method !== "POST" || url.pathname !== "/exports") return new Response(null, { status: 405, headers });
    // Refuse a large copy before it is read into memory.
    if (Number(request.headers.get("Content-Length")) > MAX_EXPORT_BYTES) return new Response(null, { status: 413, headers });
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_EXPORT_BYTES) return new Response(null, { status: 413, headers });
    this.copy = { bytes, name: (url.searchParams.get("name") ?? "document.docx").slice(0, 200) };
    setTimeout(() => { this.copy = undefined; }, 90_000).unref?.();
    return Response.json({ url: `${url.origin}/exports/${request.headers.get(RELAY_NAME)}` }, { headers });
  }
}

// Each open document has its own relay, so a relay failure stops one document
// and leaves the others working. A relay uses the session map of the Node server.
// Hibernatable WebSockets keep idle editors connected without polling.
export class WordEditorRelay {
  private readonly sessions = new EditorSessions();
  private readonly downloads = new Map<string, string>();
  private readonly sockets = new Map<string, WorkerWebSocket>();

  constructor(private readonly state: DurableObjectState, private readonly env: UsageEnv) {
    for (const socket of state.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const { editorSessionId } = socket.deserializeAttachment();
      this.sessions.connect(editorSessionId);
      this.attachSocket(editorSessionId, socket);
    }
  }

  private attachSocket(id: string, socket: WorkerWebSocket): void {
    this.sockets.get(id)?.close(EDITOR_REPLACED, "Another editor took over");
    this.sockets.set(id, socket);
    this.sessions.attach(id, command => socket.send(JSON.stringify({ command })), () => socket.close(1000, "Editor session closed"));
  }

  webSocketMessage(socket: WorkerWebSocket, message: string | ArrayBuffer): void {
    const { editorSessionId } = socket.deserializeAttachment();
    if (this.sockets.get(editorSessionId) !== socket) return;
    try {
      const reply = editorReply.parse(JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)));
      this.sessions.reply(editorSessionId, reply.commandId, reply.result);
    } catch { socket.close(1008, "Invalid or expired editor reply"); }
  }

  webSocketClose(socket: WorkerWebSocket): void {
    const { editorSessionId } = socket.deserializeAttachment();
    if (this.sockets.get(editorSessionId) !== socket) return;
    this.sockets.delete(editorSessionId);
    this.sessions.disconnect(editorSessionId);
  }

  webSocketError(socket: WorkerWebSocket): void { this.webSocketClose(socket); }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/editor/")) {
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
      const id = url.pathname.slice("/editor/".length);
      if (!this.sessions.has(id)) return new Response(null, { status: 404 });
      const [client, socket] = Object.values(new WebSocketPair());
      socket.serializeAttachment({ editorSessionId: id });
      this.state.acceptWebSocket(socket);
      this.attachSocket(id, socket);
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }
    if (url.pathname.startsWith("/attachments/")) {
      const downloadUrl = this.downloads.get(url.pathname.slice("/attachments/".length));
      if (!downloadUrl) return new Response(null, { status: 404 });
      const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
      if (request.method === "OPTIONS") return new Response(null, { headers });
      if (request.method !== "GET") return new Response(null, { status: 405, headers });
      const response = await fetchOpenAIFile(downloadUrl).catch(() => new Response(null, { status: 502 }));
      const size = Number(response.headers.get("Content-Length"));
      if (response.ok && size) recordFileSize(this.env, "open", size);
      // Always bytes, never a page: this origin must not render content it relays.
      return new Response(response.body, {
        status: response.status,
        headers: { ...headers, "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff" },
      });
    }
    // The relay name is a fresh UUID when a call has no session yet, so it also
    // serves as the new session ID and as the private attachment link. The Worker
    // answers resources/read, so the relay does not load the 6 MB editor HTML.
    const name = request.headers.get(RELAY_NAME)!;
    const server = createServer("", "", undefined, this.sessions, downloadUrl => {
      this.downloads.set(name, downloadUrl);
      setTimeout(() => this.downloads.delete(name), 90_000).unref?.();
      return `${url.origin}/attachments/${name}`;
    }, id => `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/editor/${id}`, () => name);
    return respondMcp(server, request);
  }
}

// MCP calls come from OpenAI's servers, which many users share, so /mcp gets a
// generous limit. The editor opens sockets and downloads from the user's own browser.
async function withinRateLimit(request: Request, env: Env, path: string): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (path === "/mcp") return (await env.MCP_LIMIT.limit({ key: ip })).success;
  const route = path.split("/")[1];
  return (await env.BROWSER_LIMIT.limit({ key: `${route}:${ip}` })).success;
}

// Codex re-checks every connected MCP server about every 45 seconds per open app,
// and OpenAI probes for a newer protocol before it connects. Only a tool call
// touches an editor session, so the Worker answers everything else and the relays
// only handle tool calls and editors. The Worker also answers resources/read: it
// loads the editor HTML again after every deploy.
let toolsList: Promise<string> | undefined;
let icon: Promise<string> | undefined;
let editorHtml: Promise<string> | undefined;

/** Answer a polling request in the Worker, or return null to send it to the relay. */
async function answerPolling(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "POST") return null;
  let method: unknown = "GET";
  let id: unknown;
  if (request.method === "POST") {
    let params: { name?: unknown; arguments?: { file?: { resourceUri?: unknown } | string } } | undefined;
    ({ method, id, params } = await request.clone().json().catch(() => ({})) as { method?: unknown; id?: unknown; params?: typeof params });
    if (method === "tools/call") {
      const file = params?.arguments?.file;
      // Codex lists this server twice. Only its app connector turns a path into an upload.
      if (params?.name === "open_word_document" && typeof file === "string") {
        const text = `This connection cannot read a local path. Call mcp__codex_apps__word_in_chat_open_word_document with ${JSON.stringify({ file })}. The host uploads a copy of the file.`;
        return Response.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } });
      }
      // The server refuses a file URL before it opens an editor session, so the
      // Worker answers it with the current refusal text.
      if (params?.name !== "open_word_resource" || typeof file === "string" || !String(file?.resourceUri).startsWith("file:")) return null;
    }
  }
  if (method === "tools/list") {
    // Built at deploy time (dev/prepare-worker-assets.mjs): converting every tool
    // schema costs about 15 ms of CPU, too much to repeat for each poll.
    toolsList ??= env.ASSETS.fetch("https://assets/tools-list.json").then(response => {
      if (!response.ok) throw new Error(`tools-list.json: ${response.status}`);
      return response.text();
    });
    const result = await toolsList.catch((error: unknown) => {
      toolsList = undefined;
      throw error;
    });
    return new Response(`{"result":${result},"jsonrpc":"2.0","id":${JSON.stringify(id)}}`, {
      headers: { "Content-Type": "application/json" },
    });
  }
  icon ??= env.ASSETS.fetch("https://assets/icon.svg").then(response => response.text());
  const iconSvg = await icon.catch((error: unknown) => {
    icon = undefined;
    throw error;
  });
  let html = "";
  if (method === "resources/read") {
    editorHtml ??= env.ASSETS.fetch("https://assets/app.html").then(response => response.text());
    html = await editorHtml.catch((error: unknown) => {
      editorHtml = undefined;
      throw error;
    });
  }
  return respondMcp(createServer(html, iconSvg), request);
}

/** The relay for a request: its session, its attachment link, or a new relay. */
function relayName(message: McpMessage | null, path: string): string {
  const name = message ? message.params?.arguments?.editorSessionId : path.split("/")[2];
  return typeof name === "string" && name ? name : crypto.randomUUID();
}

const ERROR_RETENTION_SECONDS = 30 * 24 * 60 * 60;

// Record the cause only. The URL, session ID, IP, and body stay out of the
// record: the privacy policy promises no request records.
function logRelayError(env: Env, ctx: ExecutionContext, stage: string, route: string, error: unknown): void {
  const { name, message, stack, retryable, overloaded } = error as { name?: string; message?: string; stack?: string; retryable?: boolean; overloaded?: boolean };
  const summary = { relayError: stage, route, name, message: message?.slice(0, 500), retryable, overloaded };
  console.error(JSON.stringify(summary));
  // Keys sort by time. The metadata makes `wrangler kv key list` show every cause in one call.
  const key = `${new Date().toISOString()}-${crypto.randomUUID().slice(0, 8)}`;
  ctx.waitUntil(env.ERROR_LOG.put(key, JSON.stringify({ ...summary, stack }), {
    metadata: summary,
    expirationTtl: ERROR_RETENTION_SECONDS,
  }).catch(() => {}));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/healthz" && request.method === "GET") {
      return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
    }
    if (path === "/.well-known/openai-apps-challenge" && request.method === "GET") {
      return new Response("qy1RkHVZQmBOiwoheIE09RnVN7eYa_i7NsLoXM4V8Eg", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    if (path === "/mcp" || path.startsWith("/attachments/") || path.startsWith("/editor/") || path === "/exports" || path.startsWith("/exports/") || path === "/timing") {
      const route = path.split("/")[1];
      // A limiter outage must not take the service down with it.
      const allowed = await withinRateLimit(request, env, path).catch((error: unknown) => {
        logRelayError(env, ctx, "rateLimit", route, error);
        return true;
      });
      if (!allowed) {
        ctx.waitUntil(recordFailure(env, request, null, "rate-limited", route).catch(() => {}));
        return new Response("Too many requests\n", { status: 429, headers: { "Retry-After": "10" } });
      }
      if (path === "/timing") {
        ctx.waitUntil(recordTiming(request, env).catch(() => {}));
        return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      // Counting must never slow or fail a request, so it runs after the response.
      if (path === "/mcp") ctx.waitUntil(recordUsage(request, env).catch(() => {}));
      if (path === "/mcp") {
        const answered = await answerPolling(request, env).catch((error: unknown) => {
          logRelayError(env, ctx, "polling", route, error);
          return null;
        });
        if (answered) return answered;
      }
      const message = path === "/mcp" ? await request.clone().json().catch(() => null) as McpMessage | null : null;
      // A relay holds no editor HTML, and a host would cache an empty template.
      if (message?.method === "resources/read") return new Response("The editor is temporarily unavailable. Retry the request.\n", { status: 503, headers: { "Retry-After": "1" } });
      const place = message?.method === "tools/call" ? String(message.params?.name).slice(0, 80) : route;
      const fail = (reason: string) => ctx.waitUntil(recordFailure(env, request, message, reason, place).catch(() => {}));
      try {
        const isExport = path.startsWith("/exports");
        const namespace = isExport ? env.EXPORT_COPIES : env.EDITOR_RELAY;
        // A new copy gets a new link, and its object is named after that link.
        const name = isExport ? (path === "/exports" ? crypto.randomUUID() : path.split("/")[2]) : relayName(message, path);
        const forwarded = new Request(request);
        forwarded.headers.set(RELAY_NAME, name);
        const response = await namespace.get(namespace.idFromName(name)).fetch(forwarded as unknown as WorkerRequest) as unknown as Response;
        const size = Number(request.headers.get("Content-Length"));
        if (request.method === "POST" && path === "/exports" && size) recordFileSize(env, "export", size);
        if (response.status >= 400) fail(`status-${response.status}`);
        else if (message?.method === "tools/call") ctx.waitUntil(recordToolFailure(env, request, message, response.clone()).catch(() => {}));
        return response;
      } catch (error) {
        // Cloudflare rejects here when the Worker-to-Durable-Object connection drops.
        logRelayError(env, ctx, "relay", route, error);
        fail("relay-unavailable");
        return new Response("The editor relay is temporarily unavailable. Retry the request.\n", { status: 503, headers: { "Retry-After": "1" } });
      }
    }
    if (path === "/review.docx" && request.method === "GET") return env.ASSETS.fetch(request as unknown as WorkerRequest);
    return new Response(null, { status: 404 });
  },
};
