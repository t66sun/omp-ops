/**
 * The base entry, and the only entry a host without feature support ever loads.
 *
 * It registers nothing and changes nothing. That is the point: omp's install-time feature bracket is a
 * *file selector*, not a runtime switch — `pkg[]` decides which modules load and nothing about the
 * bracket reaches extension code — so the honest way to make a stripped install free is for the base
 * entry to be empty and for each feature to live in its own file.
 *
 * A host that loads only this file therefore gets a valid plugin that does nothing, rather than a
 * handler that silently guards every tool result.
 */
export default function ompOps(): void {}
