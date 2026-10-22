import type { ToolObservation } from '../host/contracts.ts'

/** Filesystem identity captured when a body was read; any field changing invalidates the record. */
export interface FileIdentity {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

export interface ReadRecord {
  agentKey: string
  epoch: number
  key: string
  body: string
  bytes: number
  identity: FileIdentity
  revision: string
  messageId?: string
  callId?: string
}

/** The part of a successful result that a reference line could replace. */
export interface DedupCandidate {
  key: string
  body: string
  identity: FileIdentity
  revision: string
}

export interface DedupTarget {
  readonly name: string
  extract(o: ToolObservation): DedupCandidate | undefined
}

/** Produced only when strictly shorter than the body it replaces. */
export interface Rewrite {
  readonly text: string
}

/**
 * Per-agent record of bodies already in the model's context. Bounded on three axes so a long
 * session cannot grow without limit: agents, records, and total body bytes.
 */
export interface DedupStore {
  remember(record: ReadRecord): void
  lookup(agentKey: string, epoch: number, key: string): ReadRecord | undefined
  /** Drop every record for one agent. Called whenever a non-harmless tool result lands. */
  forget(agentKey: string): void
  size(): number
  bytes(): number
  dispose(): void
}
