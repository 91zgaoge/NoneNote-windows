export type MemoryKind = "static" | "dynamic";
export type MemoryRelation = "add" | "updates" | "extends" | "derives";

/** One stored memory fact. Versions are kept: an update supersedes, never edits. */
export interface MemoryFact {
  id: string;
  fact: string;
  kind: MemoryKind;
  relation: MemoryRelation;
  parentId?: string | null;
  rootId?: string | null;
  isLatest: boolean;
  isInference: boolean;
  /** JSON array of note ids this fact was distilled from. */
  sourceNoteIds: string;
  /** ISO yyyy-MM-dd after which the fact is no longer served. */
  forgetAfter?: string | null;
  forgotten: boolean;
  forgetReason?: string | null;
  sourceCount: number;
  createdAt: number;
  updatedAt: number;
  contentHash: string;
}

export interface MemoryState {
  noteHashes: Record<string, string>;
  chatIds: string[];
}

export interface ExtractFact {
  fact: string;
  kind?: string;
  relation?: string;
  targetId?: string | null;
  forgetAfter?: string | null;
}
