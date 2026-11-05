import type { AiProfile, AppSettings, Note, WikiPage } from "../types.ts";
import { activeProfile } from "../types.ts";
import type { HttpTransport } from "../http.ts";
import { AiClient } from "../ai/client.ts";
import type { LlmClient } from "../ai/client.ts";
import { uuid } from "../text.ts";
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
  "When the user explicitly asks you to change their notes, append exactly one ```noty " +
  "fenced JSON block (a single object or an array) after the prose. Supported actions: " +
  '{"action":"create","title":"...","body":"..."}, ' +
  '{"action":"append","title":"...","text":"..."}, ' +
  '{"action":"color","title":"...","color":"Sky"} (Lemon, Peach, Rose, Lilac, Sky, Mint, ' +
  'Sand, Slate), {"action":"archive","title":"..."}, {"action":"delete","title":"..."}. ' +
  "Use an exact existing note title (or id from the material); never invent one. Do not " +
  "add a fence unless the user asked for a change.";

const HARD_SYSTEM_CHARS = 8_000;
const HARD_USER_CHARS = 32_000;
const MAX_ANSWER_TOKENS = 2_048;
const HISTORY_MESSAGES = 6;

export interface ChatDeps {
  notes: () => Note[];
  pages: () => Promise<WikiPage[]>;
  settings: () => AppSettings;
  transport: HttpTransport;
  clientFactory?: (p: AiProfile) => LlmClient;
  now?: () => number;
  retrieval?: Partial<RetrievalOptions>;
  actions?: NoteActionExecutor;
}

/**
 * One-shot grounded answer over the compiled wiki + raw notes. No streaming,
 * no memory extraction, no agent actions yet — those remain Android-only.
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
    const recentQuestions = working.messages
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => m.content)
      .join("\n");
    const chunks = retrieve(recentQuestions || question, pages, this.deps.notes(), this.deps.retrieval);
    const context = chunks.length > 0 ? renderContext(chunks) : "";
    const history = priorMessages
      .slice(-HISTORY_MESSAGES)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");

    let user = context;
    if (history) user += `\nConversation so far:\n${history}\n`;
    user += `\nQuestion: ${question}`;
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

    const notes = this.deps.notes();
    const parsed = this.deps.actions
      ? parseAgentActions(answer)
      : { actions: [], cleanedText: answer };
    const finalActions: AgentAction[] = [];
    if (this.deps.actions && parsed.actions.length > 0) {
      const resolved = resolveAgentActions(parsed.actions, notes);
      for (const action of resolved) {
        // Archive/delete wait for the confirmation gate; the rest run now.
        if (action.status === "failed" || action.kind === "archive" || action.kind === "delete") {
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

  /** Confirmation gate for a pending archive/delete action. */
  async confirmAction(action: AgentAction): Promise<AgentAction> {
    const executor = this.deps.actions;
    if (!executor) {
      return { ...action, status: "failed", fail: "execution_failed" };
    }
    const notes = this.deps.notes();
    const resolved = resolveAgentActions([action], notes)[0];
    if (resolved.status === "failed") return resolved;
    return executeAgentAction(resolved, notes, executor);
  }
}
