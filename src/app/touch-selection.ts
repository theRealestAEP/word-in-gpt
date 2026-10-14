/** Feed touch drags into WordInWeb's existing text selection handler. */
export function enableTouchSelection(root: HTMLElement): () => void {
  let target: Element | null = null;
  let point: Touch | undefined;
  const mouse = (type: string) => new MouseEvent(type, {
    bubbles: true, cancelable: true, button: 0,
    buttons: type === "mouseup" ? 0 : 1,
    clientX: point!.clientX, clientY: point!.clientY,
  });
  const start = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;
    // Fingers can land beside a glyph or on the caret. WordInWeb resolves the
    // nearest text position from the coordinates within this page.
    target = (event.target as Element).closest(".dxw-page");
    if (!target) return;
    event.preventDefault();
    point = event.touches[0];
    target.dispatchEvent(mouse("mousedown"));
  };
  const move = (event: TouchEvent) => {
    if (!target) return;
    event.preventDefault();
    point = event.touches[0];
    document.dispatchEvent(mouse("mousemove"));
  };
  const end = (event?: TouchEvent) => {
    if (!target) return;
    event?.preventDefault();
    if (event) {
      point = event.changedTouches[0];
      document.dispatchEvent(mouse("mousemove"));
    }
    // Finish the final drag update before the editor publishes its selection.
    document.dispatchEvent(mouse("mouseup"));
    target.dispatchEvent(mouse("mouseup"));
    target = null;
  };
  root.addEventListener("touchstart", start, { passive: false });
  root.addEventListener("touchmove", move, { passive: false });
  root.addEventListener("touchend", end, { passive: false });
  root.addEventListener("touchcancel", end, { passive: false });
  return () => {
    end();
    root.removeEventListener("touchstart", start);
    root.removeEventListener("touchmove", move);
    root.removeEventListener("touchend", end);
    root.removeEventListener("touchcancel", end);
  };
}
