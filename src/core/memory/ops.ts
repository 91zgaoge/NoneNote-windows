import type { ExtractFact, MemoryFact, MemoryKind, MemoryRelation } from "./types.ts";
import { uuid } from "../text.ts";
import { sha256Sync } from "../wiki/text.ts";

export interface FactView {
  id: string;
  fact: string;
  kind: string;
  relation: string;
  parentId?: string | null;
  rootId?: string | null;
  isLatest: boolean;
  isInference: boolean;
  forgetAfter?: string | null;
  contentHash: string;
}

export interface Plan {
  inserts: MemoryFact[];
  supersedeIds: string[];
  incrementIds: string[];
}

const KINDS = new Set(["static", "dynamic"]);
const RELATIONS = new Set(["add", "updates", "extends", "derives"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Lowercase + collapsed whitespace, matching Android's memory hash key. */
export function memoryHash(text: string): string {
  return sha256Sync(text.trim().toLowerCase().replace(/\s+/g, " "));
}

/** ISO dates compare lexicographically; a fact expires the day AFTER forgetAfter. */
export function isExpired(forgetAfter: string | null | undefined, today: string): boolean {
  return !!forgetAfter && forgetAfter < today;
}

/**
 * Folds one extraction batch into the active facts. All decisions live here,
 * so malformed model output can at worst produce no inserts.
 */
export function planMemory(
  existing: FactView[],
  extracted: ExtractFact[],
  idGen: () => string = () => uuid(),
): Plan {
  const byId = new Map(existing.map((f) => [f.id, f]));
  const knownHashes = new Set(existing.map((f) => f.contentHash));
  const inserts: MemoryFact[] = [];
  const supersedeIds: string[] = [];
  const incrementIds: string[] = [];

  for (const raw of extracted) {
    const text = raw.fact.trim();
    if (!text) continue;
    const hash = memoryHash(text);
    if (knownHashes.has(hash)) {
      const hit = existing.find((f) => f.contentHash === hash);
      if (hit) incrementIds.push(hit.id);
      continue;
    }
    const kind: MemoryKind = KINDS.has(raw.kind ?? "") ? (raw.kind as MemoryKind) : "dynamic";
    const target = raw.targetId ? byId.get(raw.targetId) : undefined;
    let relation: MemoryRelation = RELATIONS.has(raw.relation ?? "")
      ? (raw.relation as MemoryRelation)
      : "add";
    if ((relation === "updates" || relation === "extends") && !target) relation = "add";
    const forgetAfter =
      raw.forgetAfter && ISO_DATE.test(raw.forgetAfter) ? raw.forgetAfter : null;

    if (relation === "updates" && target) supersedeIds.push(target.id);
    const linked =
      relation === "updates" ||
      relation === "extends" ||
      (relation === "derives" && !!target);
    const fact: MemoryFact = {
      id: idGen(),
      fact: text,
      kind,
      relation,
      parentId: linked ? target?.id ?? null : null,
      rootId: linked ? target?.rootId ?? target?.id ?? null : null,
      isLatest: true,
      isInference: relation === "derives",
      sourceNoteIds: "[]",
      forgetAfter,
      forgotten: false,
      forgetReason: null,
      sourceCount: 1,
      createdAt: 0,
      updatedAt: 0,
      contentHash: hash,
    };
    inserts.push(fact);
    knownHashes.add(hash);
  }
  return { inserts, supersedeIds, incrementIds };
}

/** Facts that may enter the prompt: latest, not forgotten, not expired. */
export function activeFacts(facts: MemoryFact[], today: string): MemoryFact[] {
  return facts.filter(
    (f) => f.isLatest && !f.forgotten && !isExpired(f.forgetAfter, today),
  );
}
