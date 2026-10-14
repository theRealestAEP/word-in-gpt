import { callServer } from "./host.ts";
import type { EditorController } from "./controller.ts";
import type { EditorCommand } from "../server/editor-sessions.ts";

type Connection = { editorSessionId: string; webSocketUrl?: string };

async function runCommand(controller: EditorController, command: EditorCommand) {
  try {
    const value = await controller.callTool(command.name, command.arguments);
    await controller.flush();
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }, { type: "text" as const, text: `Save status: ${controller.state.status}` }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
  }
}

function connectSocket(controller: EditorController, connection: Connection): () => Promise<void> {
  const { editorSessionId } = connection;
  let socket: WebSocket;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 500;
  let attempt = 0;

  const retry = () => {
    if (stopped || retryTimer !== undefined) return;
    controller.setConnection("Reconnecting chat…");
    retryTimer = setTimeout(async () => {
      retryTimer = undefined;
      const currentAttempt = ++attempt;
      try {
        const restored = await callServer<Connection>("word_editor_connect", { editorSessionId });
        if (!stopped && currentAttempt === attempt) open(restored.webSocketUrl!);
      } catch { if (currentAttempt === attempt) retry(); }
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10_000);
  };
  const open = (url: string) => {
    socket = new WebSocket(url);
    const active = socket;
    active.onopen = () => {
      if (stopped || active !== socket) return;
      retryDelay = 500;
      controller.connectChat(editorSessionId).catch(() => active.close());
    };
    active.onmessage = async event => {
      if (stopped || active !== socket) return;
      const { command } = JSON.parse(event.data) as { command: EditorCommand };
      const result = await runCommand(controller, command);
      if (!stopped && active.readyState === WebSocket.OPEN) active.send(JSON.stringify({ commandId: command.id, result }));
    };
    active.onclose = () => { if (active === socket) retry(); };
    active.onerror = () => active.close();
  };
  // Mobile browsers can suspend sockets while the page is in the background.
  const resume = () => {
    if (document.visibilityState !== "visible" || stopped) return;
    socket.onclose = null;
    socket.close();
    attempt++;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    retry();
  };
  document.addEventListener("visibilitychange", resume);
  try { open(connection.webSocketUrl!); }
  catch (error) { document.removeEventListener("visibilitychange", resume); throw error; }
  return async () => {
    stopped = true;
    attempt++;
    clearTimeout(retryTimer);
    document.removeEventListener("visibilitychange", resume);
    socket.onclose = null;
    socket.close();
    await callServer("word_editor_disconnect", { editorSessionId });
  };
}

/** Use standard server tools so the host can advertise commands to the model. */
export async function connectServerTools(controller: EditorController, existingId?: string): Promise<() => Promise<void>> {
  const connection = await callServer<Connection>("word_editor_connect", existingId ? { editorSessionId: existingId } : {});
  if (connection.webSocketUrl) return connectSocket(controller, connection);
  const { editorSessionId } = connection;
  let stopped = false;
  const close = async () => {
    stopped = true;
    await callServer("word_editor_disconnect", { editorSessionId });
  };
  try {
    await controller.connectChat(editorSessionId);
  } catch (error) { await close(); throw error; }
  void (async () => {
    while (!stopped) {
      try {
        const { command } = await callServer<{ command: EditorCommand | null }>("word_editor_poll", { editorSessionId });
        if (!command || stopped) continue;
        const result = await runCommand(controller, command);
        await callServer("word_editor_reply", { editorSessionId, commandId: command.id, result });
      } catch (error) {
        if (stopped) return;
        if (!(error instanceof Error) || (!error.message.includes("This editor session has closed.") && error.message !== "tools/call timed out")) throw error;
        controller.setConnection("Reconnecting chat…");
        await callServer("word_editor_connect", { editorSessionId });
        if (stopped) { await callServer("word_editor_disconnect", { editorSessionId }); return; }
        await controller.connectChat(editorSessionId);
      }
    }
  })().catch(error => { if (!stopped) controller.setConnection(`Chat disconnected: ${error.message}`); });
  return close;
}
