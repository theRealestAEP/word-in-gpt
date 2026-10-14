import type { AnalyticsEngineDataset } from "@cloudflare/workers-types";

export interface UsageEnv {
  USAGE: AnalyticsEngineDataset;
  // Secret. Without it a hash of an IP address could be reversed by trying every address.
  USAGE_SALT: string;
}

type McpMessage = { method?: string; params?: { _meta?: Record<string, unknown> } };

// Each Worker instance records a user at most once per day per event,
// so a busy Codex install costs one data point, not thousands.
const recorded = new Set<string>();
let recordedDay = "";

/**
 * Record one unique-user data point for an MCP request.
 *
 * ChatGPT (and Codex in the cloud) sends an anonymized user ID on tool calls,
 * so those users are counted exactly. Codex desktop sends no user ID at all,
 * so an install is approximated by its IP address and client version. That
 * hash includes the day, so it identifies an install for one day only. Only
 * hashes are stored.
 */
export async function recordUsage(request: Request, env: UsageEnv): Promise<void> {
  if (request.method !== "POST" || !env.USAGE_SALT) return;
  const message = await request.clone().json().catch(() => null) as McpMessage | null;
  if (message?.method !== "initialize" && message?.method !== "tools/call") return;

  const day = new Date().toISOString().slice(0, 10);
  if (day !== recordedDay) {
    recorded.clear();
    recordedDay = day;
  }
  const client = request.headers.get("User-Agent") ?? "";
  const subject = message.params?._meta?.["openai/subject"];
  let kind: string;
  let source: string;
  if (typeof subject === "string") {
    kind = "chatgpt";
    source = `subject:${subject}`;
  } else if (client.startsWith("codex-mcp-client/")) {
    kind = "codex-desktop";
    source = `install:${day}:${request.headers.get("CF-Connecting-IP")}:${client}`;
  } else {
    // OpenAI's relay sends initialize without a user ID; its tool calls carry one.
    return;
  }
  const event = message.method === "tools/call" ? "tool-call" : "connect";
  const user = (await sha256Hex(`${env.USAGE_SALT}:${source}`)).slice(0, 16);
  if (recorded.has(`${user}:${event}`)) return;
  recorded.add(`${user}:${event}`);
  // blob1 = client kind, blob2 = event, index1 = hashed user.
  env.USAGE.writeDataPoint({ indexes: [user], blobs: [kind, event] });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
