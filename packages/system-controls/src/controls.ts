import type { CoreWorld } from "@kikorin/ecs";
import { ControlSources, PointerControls } from "@kikorin/ecs";

type ControlInputConnection = {
  disconnect: () => void;
};

function getNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function shouldIgnoreKeyboardEventTarget(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  return (
    target.isContentEditable ||
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT"
  );
}

function mouseButtonToControlId(button: number): string {
  switch (button) {
    case 0:
      return PointerControls.Primary;
    case 1:
      return PointerControls.Middle;
    case 2:
      return PointerControls.Secondary;
    default:
      return `button-${button}`;
  }
}

export function setupControlInputs(
  world: CoreWorld,
  element: HTMLElement | null,
): ControlInputConnection {
  if (typeof window === "undefined") {
    return {
      disconnect() {
        return;
      },
    };
  }

  const disconnectors: Array<() => void> = [];

  const onKeyDown = (event: KeyboardEvent) => {
    if (shouldIgnoreKeyboardEventTarget(event)) return;
    world.controls.enqueue({
      timestamp: event.timeStamp,
      source: ControlSources.Keyboard,
      controlId: event.code,
      phase: event.repeat ? "change" : "start",
      value: 1,
      payload: {
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
      },
    });
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (shouldIgnoreKeyboardEventTarget(event)) return;
    world.controls.enqueue({
      timestamp: event.timeStamp,
      source: ControlSources.Keyboard,
      controlId: event.code,
      phase: "end",
      value: 0,
      payload: {
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      },
    });
  };

  const onBlur = () => {
    world.controls.cancelActive({ source: [ControlSources.Keyboard, ControlSources.Pointer] }, getNow());
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  disconnectors.push(() => window.removeEventListener("keydown", onKeyDown));
  disconnectors.push(() => window.removeEventListener("keyup", onKeyUp));
  disconnectors.push(() => window.removeEventListener("blur", onBlur));

  if (element) {
    const onPointerDown = (event: PointerEvent) => {
      if ("setPointerCapture" in element) {
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          // Some browsers can reject capture if the pointer is already gone.
        }
      }

      world.controls.enqueue({
        timestamp: event.timeStamp,
        source: ControlSources.Pointer,
        controlId: mouseButtonToControlId(event.button),
        phase: "start",
        value: 1,
        payload: {
          button: event.button,
          buttons: event.buttons,
          clientX: event.clientX,
          clientY: event.clientY,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
        },
      });
    };

    const onPointerUp = (event: PointerEvent) => {
      if ("releasePointerCapture" in element) {
        try {
          element.releasePointerCapture(event.pointerId);
        } catch {
          // Safe to ignore if capture was already released.
        }
      }

      world.controls.enqueue({
        timestamp: event.timeStamp,
        source: ControlSources.Pointer,
        controlId: mouseButtonToControlId(event.button),
        phase: "end",
        value: 0,
        payload: {
          button: event.button,
          buttons: event.buttons,
          clientX: event.clientX,
          clientY: event.clientY,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
        },
      });
    };

    const onPointerCancel = (event: PointerEvent) => {
      world.controls.cancelActive({ source: ControlSources.Pointer }, event.timeStamp);
    };

    const onClick = (event: MouseEvent) => {
      world.controls.enqueue({
        timestamp: event.timeStamp,
        source: ControlSources.Pointer,
        controlId: mouseButtonToControlId(event.button),
        phase: "trigger",
        value: 1,
        payload: {
          button: event.button,
          clientX: event.clientX,
          clientY: event.clientY,
          detail: event.detail,
          kind: "click",
        },
      });
    };

    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointerup", onPointerUp);
    element.addEventListener("pointercancel", onPointerCancel);
    element.addEventListener("click", onClick);
    disconnectors.push(() => element.removeEventListener("pointerdown", onPointerDown));
    disconnectors.push(() => element.removeEventListener("pointerup", onPointerUp));
    disconnectors.push(() => element.removeEventListener("pointercancel", onPointerCancel));
    disconnectors.push(() => element.removeEventListener("click", onClick));
  }

  return {
    disconnect() {
      for (let i = disconnectors.length - 1; i >= 0; i -= 1) {
        disconnectors[i]!();
      }
    },
  };
}

export function controlsSystem(world: CoreWorld) {
  world.controls.process(world, {
    timestamp: world.time.then,
    deltaMs: world.time.delta,
    deltaSeconds: world.time.delta * 0.001,
    elapsedMs: world.time.elapsed,
  });
}
