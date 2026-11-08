import type { AiProfile, AppSettings, Note, WikiPage } from "../types.ts";
import { activeProfile } from "../types.ts";
import type { HttpTransport } from "../http.ts";
import { AiClient } from "../ai/client.ts";
import type { LlmClient } from "../ai/client.ts";
import { uuid } from "../text.ts";
import { findUrls } from "../web/links.ts";
import { LinkFetcher } from "../web/linkFetcher.ts";
import { webNoteText } from "../web/webNote.ts";
import { renderContext, retrieve } from "./retrieval.ts";
import {
  executeAgentAction,
  parseAgentActions,
  resolveAgentActions,
  type NoteActionExecutor,
} from "./actions.ts";
import type { AgentAction } from "./types.ts";
import type { RetrievalOptions } from "./retrieval.ts";
import type { ChatSession } from "./types.ts";

export class ChatNotConfiguredError extends Error {
  constructor() {
    super("chat AI is not configured");
    this.name = "ChatNotConfiguredError";
  }
}

const SYSTEM =
  "You are NoneNote's second-brain assistant. Answer the user's question from the provided " +
  "wiki pages and notes. Prefer synthesis over quoting. If the material does not contain the " +
  "answer, say clearly that you could not find it in their notes; never invent facts. " +
  "Reply in the language of the question. Keep answers concise and reference pages or note " +
  "titles when you use them. " +
  "When the question contains a link, the fetched page content is appended below — ground " +
  "your answer in it (you cannot fetch links yourself), and say plainly when the appended " +
  "note says the fetch failed. " +
  "When the user explicitly asks you to change their notes, append exactly one ```noty " +
  "fenced JSON block (a single object or an array) after the prose. Supported actions: " +
  '{"action":"create","title":"...","body":"..."}, ' +
  '{"action":"append","title":"...","text":"..."}, ' +
  '{"action":"color","title":"...","color":"Sky"} (Lemon, Peach, Rose, Lilac, Sky, Mint, ' +
  'Sand, Slate), {"action":"due","title":"...","date":"yyyy-MM-dd"}, ' +
  '{"action":"archive","title":"..."}, {"action":"delete","title":"..."}, ' +
  '{"action":"event","title":"...","date":"yyyy-MM-dd","time":"HH:mm"} (time optional — ' +
  "adds a calendar event), " +
  '{"action":"diagram","title":"...","elements":[...]} (Excalidraw elements array for a ' +
  "flowchart/architecture diagram — include rectangle/ellipse/diamond/text/arrow with " +
  "startBinding/endBinding and containerId text bindings; creates a new note with a diagram " +
  "attachment). " +
  "Use an exact existing note title (or id from the material); never invent one. Do not " +
  "add a fence unless the user asked for a change.";

const HARD_SYSTEM_CHARS = 8_000;
const HARD_USER_CHARS = 32_000;
const MAX_ANSWER_TOKENS = 2_048;
const HISTORY_MESSAGES = 6;
/** A fetched page appended to one ask is capped so it can't crowd out the wiki. */
const WEB_PAGE_MAX_CHARS = 8_000;

/**
 * User-typed questions are capped before they reach a request — same bound as
 * the Android `QUESTION_MAX_CHARS` / macOS `questionMaxChars` (32k, same
 * marker). A pasted megabyte must never be delivered whole.
 */
export function capQuestion(question: string, maxChars: number = 32_000): string {
  if (question.length <= maxChars) return question;
  return question.slice(0, maxChars) + "\n[... prompt truncated to stay within budget ...]";
}

export interface ChatDeps {
  notes: () => Note[];
  pages: () => Promise<WikiPage[]>;
  settings: () => AppSettings;
  transport: HttpTransport;
  clientFactory?: (p: AiProfile) => LlmClient;
  now?: () => number;
  retrieval?: Partial<RetrievalOptions>;
  actions?: NoteActionExecutor;
  memoryBlock?: (question: string) => string | Promise<string>;
}

/**
 * One-shot grounded answer over the compiled wiki + raw notes: memory block,
 * retrieval context, a short history window, link grounding, and the agent
 * action protocol (create/append/color/due/archive/delete/event/diagram).
 * The system prompt is a stable prefix; the user message carries everything
 * variable with the question last. Hard caps: system 8k, user 32k chars.
 */
export class ChatService {
  private readonly deps: ChatDeps;

  constructor(deps: ChatDeps) {
    this.deps = deps;
  }

  async send(
    session: ChatSession,
    text: string,
    onStatus?: (status: string) => void,
  ): Promise<ChatSession> {
    const settings = this.deps.settings();
    const profile = activeProfile(settings);
    if (!profile.baseUrl.trim() || !profile.model.trim()) {
      throw new ChatNotConfiguredError();
    }
    const question = text.trim();
    if (!question) return session;
    // Privacy gate (Android 1.9.0): hidden notes never reach the model.
    const hidden = new Set(settings.aiHiddenNoteIds ?? []);

    const now = this.deps.now ?? (() => Date.now());
    const priorMessages = session.messages;
    const userMessage: ChatSession["messages"][number] = {
      role: "user",
      content: question,
      at: now(),
    };
    const working: ChatSession = {
      ...session,
      id: session.id || uuid(),
      title: session.title || question.replace(/\s+/g, " ").slice(0, 40),
      messages: [...priorMessages, userMessage],
      updatedAt: now(),
    };

    const pages = await this.deps.pages();
    // Privacy gate: hidden notes never reach retrieval or action resolution.
    const visibleNotes = this.deps.notes().filter((n) => !hidden.has(n.id));
    const recentQuestions = working.messages
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => m.content)
      .join("\n");
    const chunks = retrieve(recentQuestions || question, pages, visibleNotes, this.deps.retrieval);
    const context = chunks.length > 0 ? renderContext(chunks) : "";
    const memory = (await this.deps.memoryBlock?.(question)) ?? "";
    const history = priorMessages
      .slice(-HISTORY_MESSAGES)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");
    const web = await this.groundLinks(question);

    // The prompt-side question is capped; the session keeps the user's full text.
    let user = memory ? memory + "\n\n" : "";
    user += context;
    if (history) user += `\nConversation so far:\n${history}\n`;
    user += `\nQuestion: ${capQuestion(question)}`;
    user += web.block;
    if (user.length > HARD_USER_CHARS) {
      user = user.slice(0, HARD_USER_CHARS) + "\n[... context truncated to stay within budget ...]";
    }

    onStatus?.("asking");
    const factory =
      this.deps.clientFactory ??
      ((p: AiProfile) =>
        new AiClient(p.baseUrl, p.apiKey, p.model, p.temperature, p.maxTokens, this.deps.transport));
    const client = factory(profile);
    const answer = await client.chat(SYSTEM.slice(0, HARD_SYSTEM_CHARS), user, MAX_ANSWER_TOKENS);
    if (!answer.trim()) throw new Error("empty answer from the model");

    const notes = visibleNotes;
    const parsed = this.deps.actions
      ? parseAgentActions(answer)
      : { actions: [], cleanedText: answer };
    const finalActions: AgentAction[] = [];
    if (this.deps.actions && parsed.actions.length > 0) {
      const resolved = resolveAgentActions(parsed.actions, notes);
      for (const action of resolved) {
        // Archive/delete wait for the confirmation gate; the rest run now.
        if (
          action.status === "failed" ||
          action.kind === "archive" ||
          action.kind === "delete" ||
          action.kind === "event"
        ) {
          finalActions.push(action);
        } else {
          finalActions.push(executeAgentAction(action, notes, this.deps.actions));
        }
      }
    }

    const sources = [...new Set(chunks.map((c) => c.name))].slice(0, 8);
    return {
      ...working,
      messages: [
        ...working.messages,
        {
          role: "assistant",
          content: parsed.cleanedText.trim(),
          at: now(),
          ...(sources.length > 0 ? { sources } : {}),
          ...(finalActions.length > 0 ? { actions: finalActions } : {}),
        },
      ],
      updatedAt: now(),
    };
  }

  /**
   * When the question contains a link, fetch it and append the readable
   * content (Android's groundLinks): first URL only, capped at 8k chars,
   * with the failure note passed through so the model can say so.
   */
  private async groundLinks(
    question: string,
  ): Promise<{ block: string; failed: boolean }> {
    const url = findUrls(question)[0];
    if (!url) return { block: "", failed: false };
    const outcome = await new LinkFetcher(this.deps.transport).fetch(url);
    const note = webNoteText(url, outcome);
    const text =
      note.text.length > WEB_PAGE_MAX_CHARS
        ? note.text.slice(0, WEB_PAGE_MAX_CHARS) + "\n[…]"
        : note.text;
    return { block: `\n\n${text}`, failed: !note.ok };
  }

  /** Confirmation gate for a pending archive/delete action. */
  async confirmAction(action: AgentAction): Promise<AgentAction> {
    const executor = this.deps.actions;
    if (!executor) {
      return { ...action, status: "failed", fail: "execution_failed" };
    }
    const settings = this.deps.settings();
    const hidden = new Set(settings.aiHiddenNoteIds ?? []);
    const notes = this.deps.notes().filter((n) => !hidden.has(n.id));
    const resolved = resolveAgentActions([action], notes)[0];
    if (resolved.status === "failed") return resolved;
    return executeAgentAction(resolved, notes, executor);
  }
}
