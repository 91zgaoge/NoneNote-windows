import type { Note } from "../types.ts";
import { colorIndexByName, NOTE_COLOR_NAMES } from "../palette.ts";
import type { AgentAction, AgentActionKind, AgentFailReason } from "./types.ts";

const FENCE_RE = /```noty[ \t]*\r?\n([\s\S]*?)\r?\n?```\r?\n?/gi;

interface RawAction {
  kind: AgentActionKind;
  id?: string;
  title?: string;
  text?: string;
  color?: number;
}

const SUPPORTED: AgentActionKind[] = ["create", "append", "color", "archive", "delete"];

export interface ParsedActions {
  actions: AgentAction[];
  /** Answer with valid action fences removed; malformed fences stay visible. */
  cleanedText: string;
}

/** Pulls ```noty fenced JSON actions out of an answer (Tucky-style protocol). */
export function parseAgentActions(answer: string): ParsedActions {
  let cleaned = answer;
  const actions: AgentAction[] = [];
  for (const match of answer.matchAll(FENCE_RE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue; // leave malformed fences visible
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const found: RawAction[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const raw = toRawAction(entry as Record<string, unknown>);
      if (raw) found.push(raw);
    }
    // Only strip a fence that decoded as JSON, matching Android.
    cleaned = cleaned.replace(match[0], "");
    for (const raw of found) {
      actions.push({
        kind: raw.kind,
        id: raw.id,
        title: raw.title,
        text: raw.text,
        color: raw.color,
        colorName: raw.color === undefined ? undefined : NOTE_COLOR_NAMES[raw.color],
        status: "pending",
      });
    }
  }
  return { actions, cleanedText: cleaned.trim() };
}

function toRawAction(o: Record<string, unknown>): RawAction | null {
  const kind = typeof o.action === "string" ? o.action.toLowerCase() : "";
  if (!SUPPORTED.includes(kind as AgentActionKind)) return null;
  const text =
    typeof o.text === "string" ? o.text : typeof o.body === "string" ? o.body : undefined;
  const title = typeof o.title === "string" ? o.title : undefined;
  const id = typeof o.id === "string" ? o.id : undefined;
  let color: number | undefined;
  const rawColor = o.color;
  if (typeof rawColor === "number" && Number.isInteger(rawColor)) {
    color = rawColor;
  } else if (typeof rawColor === "string") {
    const asNumber = Number(rawColor);
    color = Number.isInteger(asNumber)
      ? asNumber
      : (colorIndexByName(rawColor) ?? undefined);
  }
  if (color !== undefined && (color < 0 || color > 7)) color = undefined;
  return { kind: kind as AgentActionKind, id, title, text, color };
}

function fail(action: AgentAction, reason: AgentFailReason): AgentAction {
  return { ...action, status: "failed", fail: reason };
}

/**
 * Resolves each action against the current notes. Target lookup is by id or
 * exact (case-insensitive) title; duplicate titles are ambiguous and never
 * guess. Destructive actions stay `pending` for the UI confirmation gate.
 */
export function resolveAgentActions(actions: AgentAction[], notes: Note[]): AgentAction[] {
  return actions.map((action) => {
    if (action.kind === "create") {
      if (!action.title?.trim() && !action.text?.trim()) return fail(action, "missing_text");
      return { ...action, status: "pending" };
    }

    let target: Note | undefined;
    if (action.id) {
      target = notes.find((n) => n.id === action.id);
      if (!target) return fail(action, "not_found");
    } else if (action.title !== undefined) {
      const hits = notes.filter((n) => n.title.toLowerCase() === action.title!.toLowerCase());
      if (hits.length === 0) return fail(action, "not_found");
      if (hits.length > 1) return fail(action, "ambiguous");
      target = hits[0];
    } else {
      return fail(action, "missing_target");
    }

    if (action.kind === "append" && !action.text?.trim()) return fail(action, "missing_text");
    if (action.kind === "color" && action.color === undefined) return fail(action, "bad_color");
    return {
      ...action,
      status: "pending",
      targetId: target.id,
      targetTitle: target.title || target.body.split(/\r?\n/)[0] || target.id,
    };
  });
}

export interface NoteActionExecutor {
  create(body: string, title?: string): Note;
  append(id: string, text: string): void;
  setColor(id: string, color: number): void;
  archive(id: string, archived: boolean): void;
  remove(id: string): void;
}

/**
 * Executes one resolved action (create/append/color/archive/delete). Returns
 * the action with its final status and display title; never throws.
 */
export function executeAgentAction(
  action: AgentAction,
  notes: Note[],
  executor: NoteActionExecutor,
): AgentAction {
  if (action.status === "failed") return action;
  try {
    switch (action.kind) {
      case "create": {
        const created = executor.create(action.text ?? "", action.title);
        return {
          ...action,
          status: "done",
          targetId: created.id,
          targetTitle: created.title || created.body.split(/\r?\n/)[0] || created.id,
        };
      }
      case "append": {
        const target = notes.find((n) => n.id === action.targetId);
        if (!target) return fail(action, "not_found");
        executor.append(target.id, action.text ?? "");
        return { ...action, status: "done" };
      }
      case "color": {
        const target = notes.find((n) => n.id === action.targetId);
        if (!target || action.color === undefined) return fail(action, "bad_color");
        executor.setColor(target.id, action.color);
        return { ...action, status: "done" };
      }
      case "archive": {
        const target = notes.find((n) => n.id === action.targetId);
        if (!target) return fail(action, "not_found");
        executor.archive(target.id, true);
        return { ...action, status: "done" };
      }
      case "delete": {
        const target = notes.find((n) => n.id === action.targetId);
        if (!target) return fail(action, "not_found");
        executor.remove(target.id);
        return { ...action, status: "done" };
      }
      default:
        return fail(action, "missing_target");
    }
  } catch {
    return { ...action, status: "failed", fail: "execution_failed" };
  }
}
