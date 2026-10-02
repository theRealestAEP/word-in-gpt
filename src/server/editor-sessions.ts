import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type EditorCommand = { id: string; name: string; arguments: Record<string, unknown> };
type Pending = {
  command: EditorCommand;
  delivered: boolean;
  finish: (result: CallToolResult) => void;
};
type Session = {
  pending?: Pending;
  wake?: () => void;
  expiry: ReturnType<typeof setTimeout>;
};

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

/** Commands run in the open editor. The session ID is a private capability;
 * there is deliberately no API that lists other users' sessions. */
export class EditorSessions {
  private readonly sessions = new Map<string, Session>();

  connect(existingId?: string): string {
    if (existingId) { this.get(existingId); return existingId; }
    const id = crypto.randomUUID();
    this.sessions.set(id, { expiry: this.expireLater(id) });
    return id;
  }

  private expireLater(id: string) {
    const timer = setTimeout(() => this.disconnect(id), 90_000);
    timer.unref?.();
    return timer;
  }

  private get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("This editor session has closed. Reopen the document to reconnect.");
    return session;
  }

  async poll(id: string): Promise<EditorCommand | null> {
    const session = this.get(id);
    if (session.wake) throw new Error("The editor already has a pending poll.");
    clearTimeout(session.expiry);
    session.expiry = this.expireLater(id);
    if (!session.pending || session.pending.delivered) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 20_000);
        function done() { clearTimeout(timer); session.wake = undefined; resolve(); }
        session.wake = done;
      });
    }
    if (!session.pending || session.pending.delivered) return null;
    session.pending.delivered = true;
    return session.pending.command;
  }

  call(id: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const session = this.get(id);
    if (session.pending) throw new Error("An editor command is running. Wait for its result before sending another.");
    return new Promise((resolve) => {
      const command = { id: crypto.randomUUID(), name, arguments: args };
      const timer = setTimeout(() => {
        // Close on timeout so a queued mutation can never execute later.
        this.disconnect(id);
      }, 45_000);
      session.pending = {
        command,
        delivered: false,
        finish: (result) => {
          clearTimeout(timer);
          session.pending = undefined;
          resolve(result);
        },
      };
      session.wake?.();
    });
  }

  reply(id: string, commandId: string, result: CallToolResult): void {
    const session = this.get(id);
    if (session.pending?.command.id !== commandId || !session.pending.delivered) {
      throw new Error("This command is no longer active. Inspect the document before making another edit.");
    }
    session.pending.finish(result);
  }

  disconnect(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.expiry);
    session.pending?.finish(failure("The editor disconnected before returning a result. An edit may have completed; inspect the document before retrying."));
    session.wake?.();
    this.sessions.delete(id);
  }
}

// Shared by requests to the hosted transport, and by the local stdio server.
export const editorSessions = new EditorSessions();
