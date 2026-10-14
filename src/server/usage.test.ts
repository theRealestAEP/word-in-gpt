import { afterEach, expect, it, vi } from "vitest";
import { recordUsage } from "./usage.ts";

afterEach(() => vi.useRealTimers());

function mcp(method: string, init: { userAgent?: string; ip?: string; subject?: string; httpMethod?: string } = {}) {
  return new Request("https://worker.example/mcp", {
    method: init.httpMethod ?? "POST",
    headers: { "User-Agent": init.userAgent ?? "openai-mcp/1.0.0", "CF-Connecting-IP": init.ip ?? "203.0.113.9" },
    body: init.httpMethod === "GET" ? undefined : JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      params: init.subject ? { name: "word_document_inspect", _meta: { "openai/subject": init.subject } } : {},
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
  expect(point).toEqual({ indexes: [expect.stringMatching(/^[0-9a-f]{16}$/)], blobs: ["chatgpt", "tool-call"] });
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
  expect(env.USAGE.writeDataPoint.mock.calls.map(([p]) => p.blobs)).toEqual([["codex-desktop", "connect"], ["codex-desktop", "tool-call"]]);
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
