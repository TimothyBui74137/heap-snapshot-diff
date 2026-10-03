import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Snapshot, DiffReporter } from '../src/index.js';

// The fake clock is the mechanism that keeps these tests deterministic: no
// test reads Date.now() or sleeps. Each call advances the counter by one,
// so callers control the exact frame ordering.
function makeClock(start = 0) {
  let t = start;
  return () => t++;
}

test('Snapshot.capture rejects non-object roots', () => {
  assert.throws(() => Snapshot.capture(null), TypeError);
  assert.throws(() => Snapshot.capture(undefined), TypeError);
  assert.throws(() => Snapshot.capture('cache'), TypeError);
  assert.throws(() => Snapshot.capture(42), TypeError);
});

test('Snapshot.capture accepts a function root', () => {
  // Functions are objects in JS and are valid roots; module-scoped roots
  // are sometimes functions (e.g. a decorated function holding metadata).
  function rootFn() {}
  rootFn.attached = 'x';
  const snap = Snapshot.capture(rootFn, { clock: makeClock() });
  assert.equal(snap.entries.size, 1);
  assert.ok(snap.entries.has('attached'));
});

test('Snapshot.capture records own enumerable string keys only', () => {
  const root = { a: 1, b: 2 };
  Object.defineProperty(root, 'hidden', { value: 3, enumerable: false });
  const sym = Symbol('s');
  root[sym] = 4;
  root.inherited = 'from prototype';
  const proto = { inherited: 'from prototype' };
  Object.setPrototypeOf(root, proto);
  // Reset the inherited own-prop so we truly only test proto inheritance.
  delete root.inherited;

  const snap = Snapshot.capture(root, { clock: makeClock() });
  assert.deepEqual([...snap.entries.keys()].sort(), ['a', 'b']);
});

test('Snapshot.capture uses the provided clock for the frame', () => {
  const clock = makeClock(100);
  const root = { x: 1 };
  const snap = Snapshot.capture(root, { clock });
  assert.equal(snap.capturedAt, 100);
});

test('Snapshot.capture rejects a clock that returns a non-integer', () => {
  const root = { x: 1 };
  assert.throws(() => Snapshot.capture(root, { clock: () => 1.5 }), TypeError);
  assert.throws(() => Snapshot.capture(root, { clock: () => -1 }), TypeError);
});

test('Snapshot.capture rejects a non-function clock', () => {
  const root = { x: 1 };
  assert.throws(() => Snapshot.capture(root, { clock: 'nope' }), TypeError);
});

test('DiffReporter.diff classifies added and removed keys', () => {
  const clock = makeClock();
  const beforeRoot = { keep: 1, gone: 2 };
  const afterRoot = { keep: 1, arrived: 3 };

  const before = Snapshot.capture(beforeRoot, { clock });
  const after = Snapshot.capture(afterRoot, { clock });
  const diff = DiffReporter.diff(before, after);

  assert.deepEqual(diff.added, ['arrived']);
  assert.deepEqual(diff.removed, ['gone']);
  assert.deepEqual(diff.unchanged, ['keep']);
});

test('DiffReporter.diff returns empty arrays when nothing changed', () => {
  const clock = makeClock();
  const root = { a: 1, b: 2 };
  const before = Snapshot.capture(root, { clock });
  const after = Snapshot.capture(root, { clock });
  const diff = DiffReporter.diff(before, after);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.unchanged, ['a', 'b']);
});

test('DiffReporter.diff treats a retained key with a changed value as unchanged', () => {
  // Membership is the policy: the key is still held by the root, so it is
  // neither added nor removed. The fingerprint would differ, but the diff
  // does not classify on fingerprint — see the README's stated policy.
  const clock = makeClock();
  const beforeRoot = { item: 'old' };
  const afterRoot = { item: 'new' };
  const before = Snapshot.capture(beforeRoot, { clock });
  const after = Snapshot.capture(afterRoot, { clock });
  const diff = DiffReporter.diff(before, after);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.unchanged, ['item']);
});

test('DiffReporter.diff preserves snapshot key order in the report', () => {
  const clock = makeClock();
  const beforeRoot = {};
  const afterRoot = {};
  // Insert in a deliberate order; the report should echo it.
  for (const k of ['zeta', 'alpha', 'mike']) afterRoot[k] = 1;
  for (const k of [' Yankee', 'tango']) beforeRoot[k] = 1; // these will be removed

  const before = Snapshot.capture(beforeRoot, { clock });
  const after = Snapshot.capture(afterRoot, { clock });
  const diff = DiffReporter.diff(before, after);

  assert.deepEqual(diff.added, ['zeta', 'alpha', 'mike']);
  assert.deepEqual(diff.removed, [' Yankee', 'tango']);
});

test('DiffReporter.diff rejects when after was captured before before', () => {
  const clock = makeClock();
  const root = { a: 1 };
  // Deliberately reverse the order using two independent clocks.
  const before = Snapshot.capture(root, { clock: makeClock(5) });
  const after = Snapshot.capture(root, { clock: makeClock(2) });
  assert.throws(() => DiffReporter.diff(before, after), RangeError);
});

test('DiffReporter.diff rejects non-Snapshot inputs', () => {
  const snap = Snapshot.capture({}, { clock: makeClock() });
  assert.throws(() => DiffReporter.diff(null, snap), TypeError);
  assert.throws(() => DiffReporter.diff(snap, { entries: new Map() }), TypeError);
});

test('Snapshot is frozen after construction', () => {
  const snap = Snapshot.capture({ a: 1 }, { clock: makeClock() });
  assert.ok(Object.isFrozen(snap));
});

test('DiffReporter.diff reports capturedAt frames from each snapshot', () => {
  const before = Snapshot.capture({ a: 1 }, { clock: makeClock(10) });
  const after = Snapshot.capture({ a: 1, b: 2 }, { clock: makeClock(20) });
  const diff = DiffReporter.diff(before, after);
  assert.equal(diff.beforeAt, 10);
  assert.equal(diff.afterAt, 20);
});
