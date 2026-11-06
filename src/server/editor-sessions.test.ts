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

  it("keeps the session and tells the model to retry when the editor has not arrived", async () => {
    vi.useFakeTimers();
    const id = open();
    const response = sessions.call(id, "word_document_inspect", { kind: "context" });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await response).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("still loading") }] });
    expect(sessions.has(id)).toBe(true);
    // The withdrawn command never reaches the editor, and the next call does.
    const retry = sessions.call(id, "word_document_inspect", { kind: "read" });
    const send = vi.fn();
    sessions.attach(id, send, vi.fn());
    expect(send.mock.calls.map(([command]) => command.arguments)).toEqual([{ kind: "read" }]);
    sessions.reply(id, send.mock.calls[0][0].id, { content: [] });
    await retry;
  });

  it("says a command did not run when the session expires before the editor arrives", async () => {
    vi.useFakeTimers();
    const id = open();
    await vi.advanceTimersByTimeAsync(60_000);
    const response = sessions.call(id, "word_document_inspect", { kind: "context" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await response).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("did not run") }] });
    expect(() => sessions.call(id, "word_document_inspect", {})).toThrow("still loading, wait 10 seconds");
  });

  it("discards a timed-out edit so a late editor cannot apply it", async () => {
    vi.useFakeTimers();
    const id = open();
    const response = sessions.call(id, "word_document_edit", {});
    await vi.advanceTimersByTimeAsync(45_000);
    expect((await response).isError).toBe(true);
    const poll = sessions.poll(id);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await poll).toBeNull();
  });

  it("resumes after mobile inactivity using the model's original reference", async () => {
    vi.useFakeTimers();
    const id = open();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sessions.connect(id)).toBe(id);
    const response = sessions.call(id, "word_document_inspect", { kind: "context" });
    const command = await sessions.poll(id);
    const result = { content: [{ type: "text" as const, text: "same open document" }] };
    sessions.reply(id, command!.id, result);
    expect(await response).toEqual(result);
  });

  it("pushes commands immediately and keeps an idle socket session alive without timers", async () => {
    vi.useFakeTimers();
    const id = open();
    const send = vi.fn(), close = vi.fn();
    sessions.attach(id, send, close);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(vi.getTimerCount()).toBe(0);
    const response = sessions.call(id, "word_document_inspect", { kind: "context" });
    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0][0];
    const result = { content: [{ type: "text" as const, text: "socket result" }] };
    sessions.reply(id, command.id, result);
    expect(await response).toEqual(result);
    expect(vi.getTimerCount()).toBe(0);
    expect(close).not.toHaveBeenCalled();
  });

  it("delivers a queued command once when a socket joins", async () => {
    const id = open();
    const response = sessions.call(id, "word_document_inspect", {});
    const send = vi.fn();
    sessions.attach(id, send, vi.fn());
    sessions.attach(id, send, vi.fn());
    expect(send).toHaveBeenCalledOnce();
    await expect(sessions.poll(id)).rejects.toThrow("WebSocket commands");
    sessions.reply(id, send.mock.calls[0][0].id, { content: [] });
    expect(await response).toEqual({ content: [] });
  });

  it("closes a socket when an edit times out and rejects its late reply", async () => {
    vi.useFakeTimers();
    const id = open();
    const send = vi.fn(), close = vi.fn();
    sessions.attach(id, send, close);
    const response = sessions.call(id, "word_document_edit", {});
    await vi.advanceTimersByTimeAsync(45_000);
    expect((await response).isError).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(() => sessions.reply(id, send.mock.calls[0][0].id, { content: [] })).toThrow("session has closed");
  });
});
