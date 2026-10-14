import { afterEach, expect, it, vi } from "vitest";
import type { EditorController } from "./controller.ts";

const callServer = vi.hoisted(() => vi.fn());
vi.mock("./host.ts", () => ({ callServer }));
import { connectServerTools } from "./server-tools.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); callServer.mockReset(); });

class TestSocket {
  static OPEN = 1;
  static sockets: TestSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose: (() => void) | null = null;
  onerror?: () => void;
  send = vi.fn();
  constructor(readonly url: string) { TestSocket.sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
}

function socketHost() {
  TestSocket.sockets = [];
  vi.stubGlobal("WebSocket", TestSocket);
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  callServer.mockResolvedValue({ editorSessionId: "same-session", webSocketUrl: "wss://worker.example/editor/same-session" });
  return {
    connectChat: vi.fn().mockResolvedValue(undefined),
    setConnection: vi.fn(),
    callTool: vi.fn().mockResolvedValue({ text: "Quarterly review" }),
    flush: vi.fn().mockResolvedValue(undefined),
    state: { status: "Saved" },
  } as unknown as EditorController;
}

it("runs commands and returns results through the socket with zero idle MCP polls", async () => {
  vi.useFakeTimers();
  const controller = socketHost();
  const close = await connectServerTools(controller, "same-session");
  const socket = TestSocket.sockets[0];
  socket.open();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(callServer).toHaveBeenCalledTimes(1);
  await socket.onmessage!({ data: JSON.stringify({ command: { id: "command-1", name: "word_document_inspect", arguments: { kind: "context" } } }) });
  expect(controller.callTool).toHaveBeenCalledWith("word_document_inspect", { kind: "context" });
  expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({ commandId: "command-1", result: { content: [{ text: '{"text":"Quarterly review"}' }, { text: "Save status: Saved" }] } });
  expect(callServer).toHaveBeenCalledTimes(1);
  await close();
  expect(callServer).toHaveBeenLastCalledWith("word_editor_disconnect", { editorSessionId: "same-session" });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(TestSocket.sockets).toHaveLength(1);
});

it("reconnects a lost socket with the same session and backs off failed connections", async () => {
  vi.useFakeTimers();
  const controller = socketHost();
  const close = await connectServerTools(controller, "same-session");
  TestSocket.sockets[0].open();
  callServer.mockRejectedValueOnce(new Error("offline"));
  TestSocket.sockets[0].close();
  await vi.advanceTimersByTimeAsync(500);
  expect(TestSocket.sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(TestSocket.sockets).toHaveLength(2);
  TestSocket.sockets[1].open();
  expect(controller.connectChat).toHaveBeenNthCalledWith(2, "same-session");
  expect(callServer).toHaveBeenLastCalledWith("word_editor_connect", { editorSessionId: "same-session" });
  await close();
});

it("reconnects when a mobile page resumes and removes the listener on close", async () => {
  vi.useFakeTimers();
  const controller = socketHost();
  const close = await connectServerTools(controller, "same-session");
  TestSocket.sockets[0].open();
  const resume = vi.mocked(document.addEventListener).mock.calls[0][1] as () => void;
  resume();
  await vi.advanceTimersByTimeAsync(500);
  expect(TestSocket.sockets).toHaveLength(2);
  await close();
  expect(document.removeEventListener).toHaveBeenCalledWith("visibilitychange", resume);
});

it("ignores a stale reconnect response after another mobile resume", async () => {
  vi.useFakeTimers();
  const controller = socketHost();
  const close = await connectServerTools(controller, "same-session");
  let resolve!: (connection: { editorSessionId: string; webSocketUrl: string }) => void;
  callServer.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  TestSocket.sockets[0].close();
  await vi.advanceTimersByTimeAsync(500);
  const resume = vi.mocked(document.addEventListener).mock.calls[0][1] as () => void;
  resume();
  resolve({ editorSessionId: "same-session", webSocketUrl: "wss://worker.example/stale" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(TestSocket.sockets).toHaveLength(2);
  expect(TestSocket.sockets[1].url).toBe("wss://worker.example/editor/same-session");
  await close();
});

it.each([
  "This editor session has closed. Reopen the document to reconnect.",
  "tools/call timed out",
])("reconnects after %s with the reference already held by the model", async (message) => {
  let connections = 0;
  let polls = 0;
  let finishPoll!: (value: { command: null }) => void;
  callServer.mockImplementation((name, args) => {
    if (name === "word_editor_connect") { connections++; return Promise.resolve({ editorSessionId: args.editorSessionId ?? "same-session" }); }
    if (name === "word_editor_poll") {
      if (++polls === 1) return Promise.reject(new Error(message));
      return new Promise(resolve => { finishPoll = resolve; });
    }
    return Promise.resolve({});
  });
  const controller = { connectChat: vi.fn().mockResolvedValue(undefined), setConnection: vi.fn() } as unknown as EditorController;
  const close = await connectServerTools(controller);
  await vi.waitFor(() => expect(controller.connectChat).toHaveBeenNthCalledWith(2, "same-session"));
  expect(connections).toBe(2);
  expect(callServer).toHaveBeenCalledWith("word_editor_connect", { editorSessionId: "same-session" });
  expect(controller.setConnection).toHaveBeenCalledWith("Reconnecting chat…");
  await close();
  finishPoll({ command: null });
  expect(callServer).toHaveBeenLastCalledWith("word_editor_disconnect", { editorSessionId: "same-session" });
});
