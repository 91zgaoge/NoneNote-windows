import type { Attachment, Note, SyncSnapshot } from "../types.ts";

/**
 * Pure LWW merge implementing the shared sync protocol: notes merge by id,
 * the larger `modified` wins (ties go to remote); a tombstone newer than the
 * note deletes it. Attachment metadata follows the side that won the note.
 */
export function merge(
  local: Note[],
  localDeleted: Record<string, number>,
  remote: SyncSnapshot,
  now: number,
  localAttachments: Record<string, Attachment[]> = {},
): SyncSnapshot {
  const deleted: Record<string, number> = {};
  for (const [id, at] of Object.entries(localDeleted)) {
    deleted[id] = Math.max(deleted[id] ?? Number.MIN_SAFE_INTEGER, at);
  }
  for (const [id, at] of Object.entries(remote.deleted)) {
    deleted[id] = Math.max(deleted[id] ?? Number.MIN_SAFE_INTEGER, at);
  }

  const byId = new Map<string, Note>();
  const remoteWon = new Set<string>();
  for (const n of local) byId.set(n.id, n);
  for (const n of remote.notes) {
    const cur = byId.get(n.id);
    if (!cur || n.modified >= cur.modified) {
      byId.set(n.id, n);
      remoteWon.add(n.id);
    }
  }

  const notes = [...byId.values()].filter((n) => {
    const tomb = deleted[n.id];
    return tomb === undefined || tomb <= n.modified;
  });

  const attachments: Record<string, Attachment[]> = {};
  for (const n of notes) {
    const list = remoteWon.has(n.id)
      ? (remote.attachments[n.id] ?? [])
      : (localAttachments[n.id] ?? []).map((a) => ({ ...a, noteId: n.id }));
    if (list.length > 0) attachments[n.id] = list;
  }

  return { updated: now, notes, deleted, attachments };
}
