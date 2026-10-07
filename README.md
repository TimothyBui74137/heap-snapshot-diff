# Heap Snapshot Diff

Captures the own enumerable references held by a single root object at two points in time and reports which references were added or removed between captures.

```js
import { Snapshot, DiffReporter } from 'heap-snapshot-diff';

function makeClock(start = 0) {
  let t = start;
  return () => t++;
}

const cache = Object.create(null); // module-scoped root

cache.user_42 = { name: 'Ada' };
const before = Snapshot.capture(cache, { clock: makeClock() });

cache.user_43 = { name: 'Grace' };
delete cache.user_42;
const after = Snapshot.capture(cache, { clock: makeClock() });

const diff = DiffReporter.diff(before, after);
// diff.added    === ['user_43']
// diff.removed  === ['user_42']
// diff.unchanged === []
// diff.beforeAt / diff.afterAt are the frame numbers from the clock.
```

## Why this exists

When a module owns a long-lived object (a cache, a listener registry, a
pool) and you suspect it is retaining references it should have released,
you want a quick, dependency-free way to ask: *what is this root holding
now that it was not holding a moment ago, and what did it drop?* Chrome
DevTools heap snapshots answer this for the whole page; this library answers
it for one object you choose, in plain JavaScript, with no install step.

The trade-off: this is **shallow, membership-only** tracking. A reference is
an own enumerable string-keyed property of the root. The diff classifies a
key as added, removed, or unchanged based on whether the key is present in
the second capture versus the first. It does **not** walk the value graph,
and it does **not** report value mutations for keys that stayed. Both of
those are deliberately out of scope — adding them would mean picking a
equality policy (referential? structural? deep?) and a traversal policy
(cycles? depth limits? visited-set?), and each choice is a different
library. This one does one thing.

The value fingerprint stored alongside each key is structural at one level
of nesting (constructor name plus sorted own keys) and exists for future
reporting use; it does not affect added/removed classification today.

## Edge you will hit

Symbol-keyed properties are not captured. If your root uses symbols as keys
(e.g. a private-symbol cache), those references will not appear in the
diff. Capturing symbols would require naming them in a report, and the
common cache-keyed-by-string case does not need it.

A retained key whose value was replaced between captures is reported as
`unchanged`, because the membership has not changed. If you need to detect
value swaps, compare the snapshots' `entries` maps yourself — but that is a
stricter policy than this library commits to.

The `clock` option exists so tests (and callers who care about ordering)
never touch wall-clock time. Pass a function that returns a monotonically
increasing integer; the library stores and returns it verbatim as
`capturedAt`. If you omit it, an internal counter is used.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

