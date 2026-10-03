/**
 * Heap accounting for the plugin-restart path.
 *
 * Restarting a plugin costs far more than it looks. Obsidian's unload does not always make the
 * previous instance collectable, so a plugin that rebuilds a large cache on load keeps the old
 * copy alive: Dataview re-indexes the vault, and one restart of it was measured at ~62 MB that
 * three forced collections could not take back (2026-10-03, 2603 notes).
 *
 * Nothing here can force a collection — Obsidian exposes no `gc` handle to plugins, the renderer
 * cannot reach the DevTools endpoint (its CSP blocks the request), and a collection would not help
 * anyway: the memory above is retained, not garbage. So the mechanism is visibility plus an
 * explicit escalation: the caller shows what a restart cost, and the user decides whether that
 * cost is worth paying again.
 */

/** A measured change in heap usage, and how to show it. */
export interface HeapDelta {
    deltaMB: number;
    label: string;
}

/** Chromium's own heap counter; absent on platforms that do not expose it. */
export function readHeapMB(): number | null {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return memory ? +(memory.usedJSHeapSize / 1048576).toFixed(1) : null;
}

/**
 * How much a restart changed the heap, as a label, or null when the counter is unavailable.
 *
 * @param before - Reading taken before the restart
 * @param after - Reading taken once the plugin has had a moment to settle
 */
export function describeHeapDelta(before: number | null, after: number | null): HeapDelta | null {
    if (before === null || after === null) {
        return null;
    }
    const deltaMB = +(after - before).toFixed(1);
    return { deltaMB, label: `Δ ${deltaMB > 0 ? '+' : ''}${deltaMB} MB` };
}

/** How long to wait before reading again, so a plugin that indexes on load has started doing so. */
export const RECLAIM_SETTLE_MS = 2500;

/** A restart whose cost is below this is not worth interrupting the user about. */
export const RECLAIM_NOTICE_THRESHOLD_MB = 5;
