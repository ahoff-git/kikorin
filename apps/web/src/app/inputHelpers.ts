// Shared raw-input capture boilerplate for the 2D and 3D games — both poll a
// live set of held key codes once per frame rather than reacting to
// individual key events, and both suppress the browser's right-click menu
// over the canvas so right-click can be used for gameplay.

export type HeldKeysTracker = {
  heldKeys: Set<string>;
  disconnect: () => void;
};

export function createHeldKeysTracker(): HeldKeysTracker {
  const heldKeys = new Set<string>();
  function onKeyDown(e: KeyboardEvent) { heldKeys.add(e.code); }
  function onKeyUp(e: KeyboardEvent) { heldKeys.delete(e.code); }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  return {
    heldKeys,
    disconnect() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    },
  };
}

export function suppressContextMenu(target: Document): () => void {
  function onContextMenu(e: MouseEvent) { e.preventDefault(); }
  target.addEventListener("contextmenu", onContextMenu);
  return () => target.removeEventListener("contextmenu", onContextMenu);
}
