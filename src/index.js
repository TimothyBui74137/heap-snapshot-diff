/**
 * Public surface of the Heap Snapshot Diff library.
 *
 * This module re-exports the pieces callers need. Keeping the entry point
 * thin means `core.js` is directly testable without going through a facade,
 * while callers still get a single import path.
 */
export { Snapshot, DiffReporter } from './core.js';
