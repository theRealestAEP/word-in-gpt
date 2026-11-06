import { afterEach, expect, it, vi } from "vitest";
import { failureReason, recordFailure, recordTiming, recordToolFailure, recordUsage, toolKind } from "./usage.ts";

afterEach(() => vi.useRealTimers());

function mcp(method: string, init: { userAgent?: string; ip?: string; subject?: string; httpMethod?: string; tool?: string } = {}) {
  return new Request("https://worker.example/mcp", {
    method: init.httpMethod ?? "POST",
    headers: { "User-Agent": init.userAgent ?? "openai-mcp/1.0.0", "CF-Connecting-IP": init.ip ?? "203.0.113.9" },
    body: init.httpMethod === "GET" ? undefined : JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      params: init.subject ? { name: init.tool ?? "word_document_inspect", _meta: { "openai/subject": init.subject } } : {},
    }),
  });
}

function usageEnv(salt = "test-salt") {
  return { USAGE: { writeDataPoint: vi.fn() }, USAGE_SALT: salt };
}

it("counts a ChatGPT user once per day by a hash of the anonymized subject", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-13T10:00:00Z") });
  const env = usageEnv();
  await recordUsage(mcp("tools/call", { subject: "user-abc" }), env as never);
  await recordUsage(mcp("tools/call", { subject: "user-abc" }), env as never);
  expect(env.USAGE.writeDataPoint).toHaveBeenCalledTimes(1);
  const [point] = env.USAGE.writeDataPoint.mock.calls[0];
  expect(point).toEqual({ indexes: [expect.stringMatching(/^[0-9a-f]{16}$/)], blobs: ["chatgpt", "tool-call", "read", "word_document_inspect"] });
  expect(JSON.stringify(point)).not.toContain("user-abc");
  // A different person is a different hash.
  await recordUsage(mcp("tools/call", { subject: "user-xyz" }), env as never);
  expect(env.USAGE.writeDataPoint.mock.calls[1][0].indexes[0]).not.toBe(point.indexes[0]);
});

it("approximates a Codex desktop install by IP and version without storing either", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-13T11:00:00Z") });
  const env = usageEnv();
  const codex = { userAgent: "codex-mcp-client/0.162.0", ip: "198.51.100.7" };
  await recordUsage(mcp("initialize", codex), env as never);
  await recordUsage(mcp("initialize", codex), env as never);
  await recordUsage(mcp("tools/call", codex), env as never);
  expect(env.USAGE.writeDataPoint.mock.calls.map(([p]) => p.blobs)).toEqual([["codex-desktop", "connect", "", ""], ["codex-desktop", "tool-call", "other", ""]]);
  const stored = JSON.stringify(env.USAGE.writeDataPoint.mock.calls);
  expect(stored).not.toContain("198.51.100.7");
  expect(stored).not.toContain("0.162.0");
  // The next day the same install gets a new hash, so it cannot be followed across days.
  const firstDay = env.USAGE.writeDataPoint.mock.calls[0][0].indexes[0];
  vi.setSystemTime(new Date("2026-10-14T11:00:00Z"));
  await recordUsage(mcp("initialize", codex), env as never);
  expect(env.USAGE.writeDataPoint).toHaveBeenCalledTimes(3);
  expect(env.USAGE.writeDataPoint.mock.calls[2][0].indexes[0]).not.toBe(firstDay);
});

it("ignores requests that say nothing about a user", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-15T09:00:00Z") });
  const env = usageEnv();
  await recordUsage(mcp("initialize"), env as never); // OpenAI's relay: no subject on initialize
  await recordUsage(mcp("tools/list", { userAgent: "codex-mcp-client/0.162.0" }), env as never);
  await recordUsage(mcp("initialize", { httpMethod: "GET" }), env as never);
  await recordUsage(new Request("https://worker.example/mcp", { method: "POST", body: "not json" }), env as never);
  expect(env.USAGE.writeDataPoint).not.toHaveBeenCalled();
});

it("needs the secret salt to produce the same hash", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-16T09:00:00Z") });
  const a = usageEnv("salt-a"), b = usageEnv("salt-b");
  await recordUsage(mcp("tools/call", { subject: "same-user" }), a as never);
  await recordUsage(mcp("tools/call", { subject: "same-user", ip: "203.0.113.10" }), b as never);
  expect(a.USAGE.writeDataPoint.mock.calls[0][0].indexes[0]).not.toBe(b.USAGE.writeDataPoint.mock.calls[0][0].indexes[0]);
});

it("records nothing without the salt secret", async () => {
  const env = usageEnv("");
  await recordUsage(mcp("tools/call", { subject: "user-abc" }), env as never);
  expect(env.USAGE.writeDataPoint).not.toHaveBeenCalled();
});

it("sorts tool calls into open, connect, read, and edit", () => {
  expect(toolKind("open_word_document")).toBe("open");
  expect(toolKind("open_word_resource")).toBe("open");
  expect(toolKind("word_editor_connect")).toBe("connect");
  expect(toolKind("word_attachment_read")).toBe("connect");
  for (const name of ["word_document_inspect", "word_document_project", "word_document_capabilities"]) expect(toolKind(name)).toBe("read");
  for (const name of ["word_document_patch", "word_document_format_paragraph", "word_document_table_cell_shading"]) expect(toolKind(name)).toBe("edit");
  expect(toolKind("something_else")).toBe("other");
  expect(toolKind(undefined)).toBe("other");
});

it("records each kind of call once per user per day, with the tool name and nothing else", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-24T09:00:00Z") });
  const env = usageEnv();
  for (const tool of ["open_word_document", "word_document_inspect", "word_document_project", "word_document_patch", "word_document_format_paragraph", "word_document_patch"]) {
    await recordUsage(mcp("tools/call", { subject: "worker", tool }), env as never);
  }
  const written = env.USAGE.writeDataPoint.mock.calls.map(([point]) => point.blobs.slice(2));
  // One data point per kind: project repeats "read", and the later edit tools repeat "edit".
  expect(written).toEqual([["open", "open_word_document"], ["read", "word_document_inspect"], ["edit", "word_document_patch"]]);
  expect(JSON.stringify(env.USAGE.writeDataPoint.mock.calls)).not.toContain("worker");
});

it("labels each kind of tool failure", () => {
  expect(failureReason("This editor session has closed. Reopen the document to reconnect.")).toBe("session-closed");
  expect(failureReason("The editor disconnected before returning a result.")).toBe("editor-disconnected");
  expect(failureReason("The editor is still loading this document, and this command did not run.")).toBe("editor-loading");
  expect(failureReason("This editor session has closed. If the document is still loading, wait 10 seconds.")).toBe("session-closed");
  expect(failureReason("An editor command is running. Wait for its result before sending another.")).toBe("editor-busy");
  expect(failureReason("MCP error -32602: Input validation error: Invalid arguments for tool word_document_patch")).toBe("invalid-input");
  expect(failureReason("That revision is not from the open document.")).toBe("stale-revision");
  expect(failureReason("Could not find the paragraph")).toBe("other");
});

it("stores the label of a failed tool call and never its text", async () => {
  const env = usageEnv();
  const message = { method: "tools/call", params: { name: "word_document_patch", _meta: { "openai/subject": "user-abc" } } };
  const failed = Response.json({ result: { isError: true, content: [{ type: "text", text: "Could not find: private contract text" }] } });
  await recordToolFailure(env as never, mcp("tools/call"), message, failed);
  const [point] = env.USAGE.writeDataPoint.mock.calls[0];
  expect(point).toEqual({ indexes: [expect.stringMatching(/^[0-9a-f]{16}$/)], blobs: ["chatgpt", "failure", "other", "word_document_patch"] });
  expect(JSON.stringify(point)).not.toContain("private contract text");
  expect(JSON.stringify(point)).not.toContain("user-abc");
});

it("ignores a tool call that worked, and counts every failure", async () => {
  const env = usageEnv();
  const message = { method: "tools/call", params: { name: "word_document_inspect" } };
  await recordToolFailure(env as never, mcp("tools/call"), message, Response.json({ result: { content: [{ type: "text", text: "revision 4" }] } }));
  expect(env.USAGE.writeDataPoint).not.toHaveBeenCalled();
  await recordFailure(env as never, mcp("tools/call"), null, "rate-limited", "mcp");
  await recordFailure(env as never, mcp("tools/call"), null, "rate-limited", "mcp");
  expect(env.USAGE.writeDataPoint.mock.calls.map(([point]) => point)).toEqual([
    { indexes: ["mcp"], blobs: ["unknown", "failure", "rate-limited", "mcp"] },
    { indexes: ["mcp"], blobs: ["unknown", "failure", "rate-limited", "mcp"] },
  ]);
});

it("stores a load's times with a coarse size and nothing that names the file", async () => {
  const env = usageEnv();
  const report = (body: unknown) => new Request("https://worker.example/timing", { method: "POST", body: JSON.stringify(body) });
  await recordTiming(report({ page: 812.4, read: 1500, show: 40_000.6, connect: 300, bytes: 1_193_220, hidden: true, name: "secret.docx" }), env as never);
  await recordTiming(report({ page: "x", bytes: 500 }), env as never);
  expect(env.USAGE.writeDataPoint.mock.calls.map(([point]) => point)).toEqual([
    { indexes: ["editor"], blobs: ["editor", "timing", "under-10mb", "hidden"], doubles: [812, 1500, 40001, 300] },
    { indexes: ["editor"], blobs: ["editor", "timing", "under-100kb", "visible"], doubles: [0, 0, 0, 0] },
  ]);
});
