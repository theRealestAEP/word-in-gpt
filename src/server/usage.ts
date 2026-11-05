import type { AnalyticsEngineDataset } from "@cloudflare/workers-types";

export interface UsageEnv {
  USAGE: AnalyticsEngineDataset;
  // Secret. Without it a hash of an IP address could be reversed by trying every address.
  USAGE_SALT: string;
}

export type McpMessage = { method?: string; params?: { name?: unknown; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> } };

// Each Worker instance records a user at most once per day per kind of call,
// so a busy Codex install costs a few data points, not thousands.
const recorded = new Set<string>();
let recordedDay = "";

/**
 * What a tool call does, so a report can tell people who opened a document
 * from people who worked on one. Tool names are public; no document content is stored.
 */
export function toolKind(name: unknown): string {
  if (typeof name !== "string") return "other";
  if (name.startsWith("open_word_")) return "open";
  if (name.startsWith("word_editor_") || name === "word_attachment_read") return "connect";
  if (["word_document_inspect", "word_document_project", "word_document_capabilities"].includes(name)) return "read";
  if (name.startsWith("word_document_")) return "edit";
  return "other";
}

/**
 * Who sent a request. ChatGPT (and Codex in the cloud) sends an anonymized user
 * ID on tool calls, so those users are counted exactly. Codex desktop sends no
 * user ID at all, so an install is approximated by its IP address and client
 * version. That hash includes the day, so it identifies an install for one day
 * only. Only hashes are stored.
 */
function identify(request: Request, message: McpMessage | null, day: string): { kind: string; source: string } | null {
  const subject = message?.params?._meta?.["openai/subject"];
  if (typeof subject === "string") return { kind: "chatgpt", source: `subject:${subject}` };
  const client = request.headers.get("User-Agent") ?? "";
  if (client.startsWith("codex-mcp-client/")) return { kind: "codex-desktop", source: `install:${day}:${request.headers.get("CF-Connecting-IP")}:${client}` };
  return null;
}

/** Record one unique-user data point for an MCP request. */
export async function recordUsage(request: Request, env: UsageEnv): Promise<void> {
  if (request.method !== "POST" || !env.USAGE_SALT) return;
  const message = await request.clone().json().catch(() => null) as McpMessage | null;
  if (message?.method !== "initialize" && message?.method !== "tools/call") return;

  const day = new Date().toISOString().slice(0, 10);
  if (day !== recordedDay) {
    recorded.clear();
    recordedDay = day;
  }
  // OpenAI's relay sends initialize without a user ID; its tool calls carry one.
  const identity = identify(request, message, day);
  if (!identity) return;
  const { kind, source } = identity;
  const event = message.method === "tools/call" ? "tool-call" : "connect";
  const action = event === "tool-call" ? toolKind(message.params?.name) : "";
  const user = (await sha256Hex(`${env.USAGE_SALT}:${source}`)).slice(0, 16);
  if (recorded.has(`${user}:${event}:${action}`)) return;
  recorded.add(`${user}:${event}:${action}`);
  // blob1 = client kind, blob2 = event, blob3 = what the call does, blob4 = tool name,
  // index1 = hashed user. Data points written before blob3 existed have it empty.
  const tool = event === "tool-call" && typeof message.params?.name === "string" ? message.params.name.slice(0, 80) : "";
  env.USAGE.writeDataPoint({ indexes: [user], blobs: [kind, event, action, tool] });
}

/**
 * The kind of a tool failure, as a fixed label. Error text can quote the
 * document, so the text itself is never stored.
 */
export function failureReason(text: string): string {
  if (text.includes("session has closed")) return "session-closed";
  if (text.includes("editor disconnected")) return "editor-disconnected";
  if (text.includes("command is running")) return "editor-busy";
  if (text.includes("Input validation error")) return "invalid-input";
  if (text.includes("revision")) return "stale-revision";
  return "other";
}

/** Count one failed request. Each failure is one data point, so a report shows how often it happens. */
export async function recordFailure(env: UsageEnv, request: Request, message: McpMessage | null, reason: string, place: string): Promise<void> {
  if (!env.USAGE_SALT) return;
  const identity = identify(request, message, new Date().toISOString().slice(0, 10));
  const user = identity ? (await sha256Hex(`${env.USAGE_SALT}:${identity.source}`)).slice(0, 16) : place;
  // blob1 = client kind, blob2 = "failure", blob3 = reason, blob4 = tool name or route.
  env.USAGE.writeDataPoint({ indexes: [user], blobs: [identity?.kind ?? "unknown", "failure", reason, place] });
}

/** Count a tool call that answered with an error. */
export async function recordToolFailure(env: UsageEnv, request: Request, message: McpMessage, response: Response): Promise<void> {
  const { result, error } = await response.json() as { result?: { isError?: boolean; content?: { text?: string }[] }; error?: { message?: string } };
  if (!error && !result?.isError) return;
  const text = error?.message ?? result?.content?.[0]?.text ?? "";
  await recordFailure(env, request, message, failureReason(text), String(message.params?.name).slice(0, 80));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
