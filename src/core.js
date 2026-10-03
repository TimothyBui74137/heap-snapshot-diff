/**
 * Heap snapshot capture and diff.
 *
 * The library tracks a developer-chosen "root object" — an object that a
 * module owns and that is suspected of retaining references over time
 * (caches, listener arrays, registry maps, etc.). Two snapshots are taken;
 * the diff reports which references were added or removed between them.
 *
 * Design choices, stated plainly:
 *
 * 1. Shallow references only. A "reference held by the root" is a direct
 *    own enumerable string-keyed property of the root at capture time. The
 *    brief says "references held by a module-scoped root object"; we read
 *    that literally — the root's own slots — and do not traverse deeper.
 *    Transitively-reachable object graphs are a different tool (Chrome
 *    DevTools, v8 heap snapshots) and pretending to do that here would be a
 *    lie. This is stated in the README so nobody is surprised.
 *
 * 2. A reference is identified by its key plus a structural fingerprint of
 *    its value's type. Two captures are compared by key: a key present in
 *    the second capture but not the first is an addition; a key present in
 *    the first but not the second is a removal. A key present in both is
 *    "unchanged" for the purposes of set membership, even if its value's
 *    fingerprint changed. Reporting value-mutation for retained keys would
 *    require a stricter equality policy than the brief asks for, and picking
 *    one (===? deep? by-type?) would invite the kind of conflicting-rules
 *    failure the project brief warns against. We do one thing: membership.
 *
 * 3. The value fingerprint is a structural description, not a deep clone.
 *    For objects and arrays we record the constructor name and the sorted
 *    list of own enumerable keys. This makes diffs stable across reordering
 *    of keys (which JavaScript engines do not guarantee anyway) while still
 *    being cheap. It deliberately does NOT recurse into nested values, which
 *    keeps capture cost bounded by the root's own keys.
 */

/**
 * A capture of the root's own enumerable string-keyed references at one
 * moment. Construct one with `Snapshot.capture(root)` and pass two of them
 * to `DiffReporter.diff`.
 */
export class Snapshot {
  /**
   * @param {Map<string, string>} entries Key → fingerprint. The Map is used
   *   internally because insertion order is preserved and gives stable
   *   iteration when producing reports; the caller never sees it directly.
   * @param {number} capturedAt Frame number supplied by the caller's clock.
   *   Stored as-is; this library never touches wall-clock time, so tests are
   *   deterministic.
   */
  constructor(entries, capturedAt) {
    if (!(entries instanceof Map)) {
      throw new TypeError('Snapshot entries must be a Map');
    }
    if (!Number.isInteger(capturedAt) || capturedAt < 0) {
      throw new TypeError('capturedAt must be a non-negative integer frame');
    }
    /** @type {Map<string, string>} */
    this.entries = entries;
    /** @type {number} */
    this.capturedAt = capturedAt;
    Object.freeze(this);
  }

  /**
   * Capture a snapshot of `root`'s own enumerable string-keyed properties.
   *
   * Symbol-keyed properties are intentionally excluded: they are awkward to
   *   name in a report, and the common case (module-scoped caches keyed by
   *   strings) does not need them. If a caller needs symbol-keyed tracking,
   *   that is a different library.
   *
   * @param {object} root The object whose own references to capture.
   * @param {object} [options]
   * @param {() => number} [options.clock] A function returning a monotonically
   *   increasing integer frame number. Defaults to a simple internal counter
   *   so the common case needs no setup. Tests pass a fake clock to pin
   *   ordering without touching real time.
   * @returns {Snapshot}
   */
  static capture(root, options = {}) {
    if (root === null || (typeof root !== 'object' && typeof root !== 'function')) {
      throw new TypeError('Snapshot.capture requires an object or function root');
    }
    const clock = options.clock;
    if (clock !== undefined && typeof clock !== 'function') {
      throw new TypeError('options.clock must be a function returning a number');
    }
    const frame = clock ? clock() : defaultFrame();
    if (!Number.isInteger(frame) || frame < 0) {
      throw new TypeError('clock must return a non-negative integer');
    }

    const entries = new Map();
    for (const key of Object.keys(root)) {
      const value = root[key];
      entries.set(key, fingerprint(value));
    }
    return new Snapshot(entries, frame);
  }
}

let nextDefaultFrame = 0;
/**
 * Internal monotonic counter used when no caller clock is supplied. Module
 * state is acceptable here because the default is only a convenience; any
 * test that cares about the exact frame passes its own clock.
 * @returns {number}
 */
function defaultFrame() {
  return nextDefaultFrame++;
}

/**
 * Produce a structural fingerprint for a value, used only to distinguish
 * values well enough that a future, stricter mode *could* be added. Today
 * the diff only uses key membership, so the fingerprint is informational in
 * the report and does not affect added/removed classification.
 *
 * Primitives get a tag + toString. Functions and objects get their
 * constructor name plus their sorted own enumerable keys, which is stable
 * against key-reordering. We deliberately stop at one level of nesting —
 * see the file header for why.
 *
 * @param {*} value
 * @returns {string}
 */
function fingerprint(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type !== 'object' && type !== 'function') {
    return `${type}:${String(value)}`;
  }
  // Constructor name falls back to 'Object' for plain objects and to
  // 'Function' for functions whose constructor name is empty (e.g. arrow
  // functions in some engines report ''). Using '' would produce an ugly
  // fingerprint and gain us nothing.
  const ctorName = (value.constructor && value.constructor.name) || (type === 'function' ? 'Function' : 'Object');
  const keys = Object.keys(value).sort();
  return `${ctorName}{${keys.join(',')}}`;
}

/**
 * Computes and reports the membership difference between two snapshots.
 */
export class DiffReporter {
  /**
   * @param {Snapshot} before
   * @param {Snapshot} after
   * @returns {{added: string[], removed: string[], unchanged: string[], beforeAt: number, afterAt: number}}
   *   Keys are returned in insertion order of the snapshot that owns them,
   *   which (because Snapshot uses a Map) is the order they were seen on the
   *   root at capture time. This keeps reports stable and human-readable.
   */
  static diff(before, after) {
    if (!(before instanceof Snapshot) || !(after instanceof Snapshot)) {
      throw new TypeError('DiffReporter.diff requires two Snapshot instances');
    }
    if (after.capturedAt < before.capturedAt) {
      throw new RangeError('after snapshot was captured before the before snapshot');
    }

    const added = [];
    const removed = [];
    const unchanged = [];

    for (const [key] of after.entries) {
      if (before.entries.has(key)) {
        unchanged.push(key);
      } else {
        added.push(key);
      }
    }
    for (const [key] of before.entries) {
      if (!after.entries.has(key)) {
        removed.push(key);
      }
    }

    return {
      added,
      removed,
      unchanged,
      beforeAt: before.capturedAt,
      afterAt: after.capturedAt,
    };
  }
}
