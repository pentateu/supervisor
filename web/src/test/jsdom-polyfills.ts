// jsdom test polyfills (import at the top of jsdom test files).
//
// jsdom has no layout engine and lacks ResizeObserver + DOMMatrixReadOnly:
// `offsetWidth/offsetHeight` are always 0 and React Flow never fires its
// resize callbacks, so nodes are never "initialized" and edges never render.
// These stubs give React Flow enough to measure nodes and render edges.

if (typeof window !== "undefined") {
  class ResizeObserverStub {
    private readonly targets = new Set<Element>();
    constructor(private readonly cb: (entries: ResizeObserverEntry[]) => void) {}
    observe(target: Element) {
      this.targets.add(target);
      // Fire on a microtask, like a real ResizeObserver — a synchronous fire
      // runs before React Flow has attached its `domNode` store ref and the
      // measurement is silently skipped. Tests flush this with
      // `await act(async () => {})`.
      queueMicrotask(() => {
        if (!this.targets.has(target)) return;
        this.cb([
          {
            target,
            contentRect: {
              x: 0,
              y: 0,
              width: 180,
              height: 64,
              top: 0,
              left: 0,
              right: 180,
              bottom: 64,
              toJSON: () => ({}),
            },
          } as unknown as ResizeObserverEntry,
        ]);
      });
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }

  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  });

  // jsdom reports 0 for offset sizes (no layout). A card-shaped size keeps
  // React Flow's node measurement and fitView happy.
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 180 },
    offsetHeight: { configurable: true, get: () => 64 },
  });

  class DOMMatrixReadOnlyStub {
    readonly m22: number = 1;
    constructor(transform: string) {
      const scale = /scale\(([\d.]+)\)/.exec(transform);
      if (scale) this.m22 = Number(scale[1]);
    }
  }
  Object.defineProperty(window, "DOMMatrixReadOnly", {
    configurable: true,
    writable: true,
    value: DOMMatrixReadOnlyStub,
  });

  // Edge labels are measured with getBBox, which jsdom does not implement.
  Object.defineProperty(window.SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 60, height: 14, top: 0, left: 0, right: 60, bottom: 14 }),
  });
}
