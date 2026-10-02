import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DocxToolbar, DocxView, useAgentDocumentSession, type AgentDocumentViewBinding, type DocxViewApi } from "wordinweb";
import { localDocumentViewBinding } from "@wordinweb/agent";
import type { EditorController, OpenDocument } from "./controller.ts";
import type { PresencePosition, SelectionRange } from "./selection.ts";

export function App({ controller }: { controller: EditorController }) {
  const { file, doc, status, conflict, connection } = useSyncExternalStore(controller.subscribe, controller.getState);
  const [api, setApi] = useState<DocxViewApi | null>(null);
  const [selection, setSelection] = useState<SelectionRange[]>([]);
  const selectionRef = useRef<SelectionRange[]>([]);
  const [selectionStatus, setSelectionStatus] = useState("");
  useEffect(() => { setApi(null); setSelection([]); selectionRef.current = []; setSelectionStatus(""); }, [doc]);
  const onSelection = useMemo(() => (position: PresencePosition | null) => {
    selectionRef.current = position?.ranges ?? [];
    setSelection(selectionRef.current);
    setSelectionStatus("");
  }, []);

  const shareSelection = useCallback(async (ranges: SelectionRange[]) => {
    try {
      await controller.shareSelection(ranges);
      setSelectionStatus("Added to chat");
    } catch (error) { controller.report(error); }
  }, [controller]);

  useEffect(() => {
    if (!doc || connection !== "Chat connected") return;
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as Element;
      if (!target.closest('.document [data-dxw-item-kind="text"]')) return;
      // WordInWeb creates its text menu during this event. Keep its existing
      // commands and wait for its menu and selection notification.
      setTimeout(() => {
        const ranges = selectionRef.current;
        if (!ranges.length) return;
        const menu = document.querySelector<HTMLElement>("[data-dxw-text-context-menu]");
        if (!menu) return;
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.className = "add-to-chat-menu-item";
        button.textContent = "Add to chat";
        button.onmousedown = event => event.preventDefault();
        button.onclick = () => { menu.remove(); void shareSelection(ranges); };
        menu.prepend(button);
        const bounds = menu.getBoundingClientRect();
        menu.style.top = `${Math.max(6, Math.min(bounds.top, window.innerHeight - bounds.height - 6))}px`;
      }, 0);
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    return () => document.removeEventListener("contextmenu", onContextMenu, true);
  }, [doc, connection, shareSelection]);

  return (
    <div className="editor" onMouseUpCapture={event => {
      // WordInWeb's mouseup handler places the caret. Context clicks must keep
      // the selection, including Control-click on macOS.
      if ((event.target as Element).closest(".document") &&
          (event.button !== 0 || (event.ctrlKey && /Mac|iPhone|iPad/.test(navigator.platform)))) {
        event.stopPropagation();
      }
    }}>
      <div className="status-bar" role="status">
        <span className="file-name">{file?.name ?? "Word"}</span>
        <button className="share-selection" disabled={!selection.length || connection !== "Chat connected"}
          onMouseDown={event => event.preventDefault()} onClick={() => shareSelection(selection)}>Add to chat</button>
        <div className="document-status">
          <span className="save-status">{status}</span>
          <span>{connection}</span>
          {selectionStatus && <span>{selectionStatus}</span>}
        </div>
        {conflict && (
          <span className="conflict">
            Another program changed this file while you had unsaved edits.
            <button onClick={() => controller.loadDiskVersion().catch(controller.report)}>Load the file on disk</button>
            <button onClick={() => controller.keepThisVersion()}>Keep this version</button>
          </span>
        )}
      </div>
      {api && <DocxToolbar api={api} mode="advanced" className="word-toolbar" />}
      {doc ? (
        <DocumentView key={doc.id} doc={doc} onEdit={controller.noteEdit} onReady={setApi} onError={controller.report} onSelection={onSelection} />
      ) : (
        <p className="empty">Open a .docx file in ChatGPT or Codex to view and edit it here.</p>
      )}
    </div>
  );
}

function DocumentView({ doc, onEdit, onReady, onError, onSelection }: {
  doc: OpenDocument;
  onEdit: () => void;
  onReady: (api: DocxViewApi) => void;
  onError: (error: Error) => void;
  onSelection: (position: PresencePosition | null) => void;
}) {
  // Typing and undo apply to the document before they reach the session, so the
  // session does not notify subscribers about them. Count them here.
  const binding = useMemo(() => {
    const base = localDocumentViewBinding(doc.session);
    return {
      ...base,
      submit: (operation: Parameters<typeof base.submit>[0]) => {
        base.submit(operation);
        onEdit();
      },
      noteHistory: () => {
        base.noteHistory();
        onEdit();
      },
    };
  }, [doc, onEdit]);
  // wordinweb and @wordinweb/agent each bundle their own copy of DocxDocument.
  // The classes are the same code, but TypeScript treats their private fields as different types.
  const view = useAgentDocumentSession(binding as unknown as AgentDocumentViewBinding);
  return <DocxView {...view} collab={{ ...view.collab!, setPresence: onSelection }} editable commentAuthor="You"
    narrowWidth={1100} onReady={onReady} onError={onError} className="document" />;
}
