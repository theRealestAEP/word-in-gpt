import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.ts";
import { EditorSessions } from "./editor-sessions.ts";
import type { DurableObjectNamespace, DurableObjectState, Fetcher, Request as WorkerRequest } from "@cloudflare/workers-types";

interface Env {
  ASSETS: Fetcher;
  EDITOR_RELAY: DurableObjectNamespace;
}

// One relay owns the same private session map used by the Node server.
// A Durable Object keeps calls and editor polls in the same isolate.
export class WordEditorRelay {
  private readonly sessions = new EditorSessions();
  private readonly assets: Promise<[string, string]>;

  constructor(_state: DurableObjectState, env: Env) {
    this.assets = Promise.all([
      env.ASSETS.fetch("https://assets/app.html").then(response => response.text()),
      env.ASSETS.fetch("https://assets/icon.svg").then(response => response.text()),
    ]);
  }

  async fetch(request: Request): Promise<Response> {
    const [html, icon] = await this.assets;
    const server = createServer(html, icon, undefined, this.sessions);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  }
}

export default {
  fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (path === "/healthz" && request.method === "GET") {
      return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
    }
    if (path === "/mcp") {
      return env.EDITOR_RELAY.get(env.EDITOR_RELAY.idFromName("word-editor-relay")).fetch(request as unknown as WorkerRequest);
    }
    return new Response(null, { status: 404 });
  },
};
