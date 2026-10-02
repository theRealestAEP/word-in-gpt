import { callServer } from "./host.ts";
import type { EditorController } from "./controller.ts";
import type { EditorCommand } from "../server/editor-sessions.ts";

/** Use standard server tools so the host can advertise commands to the model. */
export async function connectServerTools(controller: EditorController, existingId?: string): Promise<() => Promise<void>> {
  const { editorSessionId } = await callServer<{ editorSessionId: string }>("word_editor_connect", existingId ? { editorSessionId: existingId } : {});
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
      const { command } = await callServer<{ command: EditorCommand | null }>("word_editor_poll", { editorSessionId });
      if (!command || stopped) continue;
      let result;
      try {
        const value = await controller.callTool(command.name, command.arguments);
        await controller.flush();
        result = { content: [{ type: "text", text: JSON.stringify(value) }, { type: "text", text: `Save status: ${controller.state.status}` }] };
      } catch (error) {
        result = { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
      await callServer("word_editor_reply", { editorSessionId, commandId: command.id, result });
    }
  })().catch(error => { if (!stopped) controller.setConnection(`Chat disconnected: ${error.message}`); });
  return close;
}
