import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "./server.ts";

/** Answer one MCP request statelessly with a fresh transport. */
export async function respondMcp(server: McpServer, request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

/**
 * The hosted server's tools/list result, as JSON text. The asset build stores it
 * so the Worker answers tools/list without converting every tool schema, which
 * costs about 15 ms of CPU per request.
 */
export async function toolsListResult(): Promise<string> {
  const response = await respondMcp(createServer("", ""), new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  }));
  return JSON.stringify((await response.json() as { result: unknown }).result);
}
