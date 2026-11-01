import { createServer, fetchOpenAIFile } from "./server.ts";
import { EditorSessions } from "./editor-sessions.ts";
import { recordUsage, type UsageEnv } from "./usage.ts";
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
  // Limits live in wrangler.jsonc. Counts are per caller IP and per Cloudflare location.
  MCP_LIMIT: RateLimit;
  BROWSER_LIMIT: RateLimit;
  ERROR_LOG: KVNamespace;
}

// One relay owns the same private session map used by the Node server.
// Hibernatable WebSockets keep idle editors connected without polling.
export class WordEditorRelay {
  private readonly sessions = new EditorSessions();
  private readonly downloads = new Map<string, string>();
  private readonly assets: Promise<[string, string]>;
  private readonly sockets = new Map<string, WorkerWebSocket>();

  constructor(private readonly state: DurableObjectState, env: Env) {
    this.assets = Promise.all([
      env.ASSETS.fetch("https://assets/app.html").then(response => response.text()),
      env.ASSETS.fetch("https://assets/icon.svg").then(response => response.text()),
    ]);
    for (const socket of state.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const { editorSessionId } = socket.deserializeAttachment();
      this.sessions.connect(editorSessionId);
      this.attachSocket(editorSessionId, socket);
    }
  }

  private attachSocket(id: string, socket: WorkerWebSocket): void {
    this.sockets.get(id)?.close(1000, "Editor reconnected");
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
      // Always bytes, never a page: this origin must not render content it relays.
      return new Response(response.body, {
        status: response.status,
        headers: { ...headers, "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff" },
      });
    }
    const [html, icon] = await this.assets;
    const server = createServer(html, icon, undefined, this.sessions, downloadUrl => {
      const token = crypto.randomUUID();
      this.downloads.set(token, downloadUrl);
      setTimeout(() => this.downloads.delete(token), 90_000).unref?.();
      return `${url.origin}/attachments/${token}`;
    }, id => `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/editor/${id}`);
    return respondMcp(server, request);
  }
}

// MCP calls come from OpenAI's servers, which many users share, so /mcp gets a
// generous limit. The editor opens sockets and downloads from the user's own browser.
async function withinRateLimit(request: Request, env: Env, path: string): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (path === "/mcp") return (await env.MCP_LIMIT.limit({ key: ip })).success;
  const route = path.startsWith("/editor/") ? "editor" : "attachments";
  return (await env.BROWSER_LIMIT.limit({ key: `${route}:${ip}` })).success;
}

// Codex re-checks every connected MCP server about every 45 seconds per open app.
// None of these requests touches an editor session, so the Worker answers them
// and the single relay only handles tool calls and editors. The Worker also
// answers resources/read: it loads the editor HTML again after every deploy,
// while the long-lived relay keeps the copy it loaded when it started.
const POLLING_METHODS = new Set(["initialize", "notifications/initialized", "ping", "tools/list", "resources/read"]);
let toolsList: Promise<string> | undefined;
let icon: Promise<string> | undefined;
let editorHtml: Promise<string> | undefined;

/** Answer a polling request in the Worker, or return null to send it to the relay. */
async function answerPolling(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "POST") return null;
  let method: unknown = "GET";
  let id: unknown;
  if (request.method === "POST") {
    ({ method, id } = await request.clone().json().catch(() => ({})) as { method?: unknown; id?: unknown });
    if (typeof method !== "string" || !POLLING_METHODS.has(method)) return null;
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
    if (path === "/mcp" || path.startsWith("/attachments/") || path.startsWith("/editor/")) {
      const route = path.split("/")[1];
      // A limiter outage must not take the service down with it.
      const allowed = await withinRateLimit(request, env, path).catch((error: unknown) => {
        logRelayError(env, ctx, "rateLimit", route, error);
        return true;
      });
      if (!allowed) return new Response("Too many requests\n", { status: 429, headers: { "Retry-After": "10" } });
      // Counting must never slow or fail a request, so it runs after the response.
      if (path === "/mcp") ctx.waitUntil(recordUsage(request, env).catch(() => {}));
      if (path === "/mcp") {
        const answered = await answerPolling(request, env).catch((error: unknown) => {
          logRelayError(env, ctx, "polling", route, error);
          return null;
        });
        if (answered) return answered;
      }
      try {
        return await env.EDITOR_RELAY.get(env.EDITOR_RELAY.idFromName("word-editor-relay")).fetch(request as unknown as WorkerRequest);
      } catch (error) {
        // Cloudflare rejects here when the Worker-to-Durable-Object connection drops.
        logRelayError(env, ctx, "relay", route, error);
        return new Response("The editor relay is temporarily unavailable. Retry the request.\n", { status: 503, headers: { "Retry-After": "1" } });
      }
    }
    if (path === "/review.docx" && request.method === "GET") return env.ASSETS.fetch(request as unknown as WorkerRequest);
    return new Response(null, { status: 404 });
  },
};
