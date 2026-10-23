import type { CoverageMeta } from './outcome.ts'

/** What a scanner observed when it stopped, before it is reduced to `CoverageMeta`. */
export interface CoverageInput {
  /** Omitted when the scanner cannot report how many files it examined; never faked as zero. */
  scannedFiles?: number
  matchedCount: number
  scanComplete: boolean
  truncatedBy?: 'scan-budget' | 'output-budget' | 'time-limit' | 'row-limit'
}

/**
 * Derives `CoverageMeta` from one scan. `truncatedBy` survives only on an incomplete scan: a
 * truncation reason attached to a complete scan would be a lie, so it is dropped rather than
 * trusted from the caller.
 */
export function coverageOf(i: CoverageInput): CoverageMeta {
  const meta: CoverageMeta = {
    matchedCount: i.matchedCount,
    isComplete: i.scanComplete,
  }
  if (i.scannedFiles !== undefined) meta.scannedFiles = i.scannedFiles
  if (i.scanComplete === false && i.truncatedBy !== undefined) meta.truncatedBy = i.truncatedBy
  return meta
}
