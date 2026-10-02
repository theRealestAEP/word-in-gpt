import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSessions } from "./editor-sessions.ts";

describe("live editor routing", () => {
  const sessions = new EditorSessions();
  const ids: string[] = [];
  const open = () => { const id = sessions.connect(); ids.push(id); return id; };
  afterEach(() => { ids.splice(0).forEach(id => sessions.disconnect(id)); vi.useRealTimers(); });

  it("returns the live editor's result to the waiting model call", async () => {
    const id = open();
    const poll = sessions.poll(id);
    const response = sessions.call(id, "word_document_inspect", { kind: "context" });
    const command = await poll;
    expect(command).toMatchObject({ name: "word_document_inspect", arguments: { kind: "context" } });
    const result = { content: [{ type: "text" as const, text: "live document contents" }] };
    sessions.reply(id, command!.id, result);
    expect(await response).toEqual(result);
  });

  it("isolates documents and rejects replies from a different session", async () => {
    const a = open(), b = open();
    const response = sessions.call(a, "word_document_edit", {});
    const command = await sessions.poll(a);
    expect(() => sessions.reply(b, command!.id, { content: [] })).toThrow("no longer active");
    expect(() => sessions.call(a, "word_document_edit", {})).toThrow("command is running");
    sessions.disconnect(a);
    expect((await response).isError).toBe(true);
  });

  it("discards a timed-out edit so a late editor cannot apply it", async () => {
    vi.useFakeTimers();
    const id = open();
    const response = sessions.call(id, "word_document_edit", {});
    await vi.advanceTimersByTimeAsync(45_000);
    expect((await response).isError).toBe(true);
    await expect(sessions.poll(id)).rejects.toThrow("session has closed");
  });
});
