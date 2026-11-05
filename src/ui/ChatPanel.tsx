import { useEffect, useRef, useState } from "react";
import type { AppModel } from "../appModel.ts";
import type { ChatSession } from "../core/chat/types.ts";
import { uuid } from "../core/text.ts";
import { activeProfile } from "../core/types.ts";
import { t, type Lang } from "../i18n.ts";

interface Props {
  model: AppModel;
  lang: Lang;
}

export function ChatPanel({ model, lang }: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void model.chatStore.load().then((loaded) => {
      setSessions(loaded);
      setActiveId(loaded[0]?.id ?? null);
    });
  }, [model]);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const profile = activeProfile(model.settingsStore.get());
  const configured = !!profile.baseUrl.trim() && !!profile.model.trim();

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [active?.messages.length, sending]);

  function persist(next: ChatSession[]) {
    setSessions(next);
    void model.chatStore.save(next);
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setNotice(null);
    const base: ChatSession = active ?? {
      id: uuid(),
      title: "",
      messages: [],
      updatedAt: Date.now(),
    };
    const optimistic: ChatSession = {
      ...base,
      title: base.title || text.replace(/\s+/g, " ").slice(0, 40),
      messages: [...base.messages, { role: "user", content: text, at: Date.now() }],
      updatedAt: Date.now(),
    };
    setSessions((prev) => upsert(prev, optimistic));
    setActiveId(optimistic.id);
    setInput("");
    setSending(true);
    try {
      const updated = await model.chatService.send(base, text);
      const next = upsert(sessions.filter((s) => s.id !== optimistic.id), updated);
      persist(next);
      setActiveId(updated.id);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setNotice(
        e instanceof Error && e.name === "ChatNotConfiguredError"
          ? t(lang, "chat.notConfigured")
          : t(lang, "chat.failed", { detail }),
      );
      const next = upsert(sessions.filter((s) => s.id !== optimistic.id), optimistic);
      persist(next);
    } finally {
      setSending(false);
    }
  }

  function newChat() {
    setActiveId(null);
    setInput("");
    setNotice(null);
  }

  function deleteChat(id: string) {
    if (!window.confirm(t(lang, "chat.delete"))) return;
    const next = sessions.filter((s) => s.id !== id);
    persist(next);
    if (activeId === id) setActiveId(next[0]?.id ?? null);
  }

  return (
    <div className="chat-shell">
      <aside className="chat-sessions">
        <div className="row" style={{ marginBottom: 8 }}>
          <button type="button" className="button primary" onClick={newChat}>
            + {t(lang, "chat.new")}
          </button>
        </div>
        <ul>
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={`chat-session${s.id === activeId ? " active" : ""}`}
                onClick={() => setActiveId(s.id)}
              >
                <span className="title">{s.title || t(lang, "chat.new")}</span>
                <span className="muted">{new Date(s.updatedAt).toLocaleDateString()}</span>
              </button>
              <button
                type="button"
                className="chat-delete"
                title={t(lang, "chat.delete")}
                onClick={() => deleteChat(s.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="chat-main">
        <div className="chat-header">
          <div>
            <h2>{t(lang, "chat.title")}</h2>
            <p className="muted">
              {t(lang, "chat.messages", { n: active?.messages.length ?? 0 })}
            </p>
          </div>
        </div>

        {!configured && <div className="banner">{t(lang, "chat.notConfigured")}</div>}
        {notice && <div className="banner">{notice}</div>}

        <div className="chat-messages" ref={listRef}>
          {!active || active.messages.length === 0 ? (
            <div className="empty">
              <h2>{t(lang, "chat.emptyTitle")}</h2>
              <p>{t(lang, "chat.emptyHint")}</p>
            </div>
          ) : (
            active.messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <div className="msg-content">{m.content}</div>
                {m.sources && m.sources.length > 0 && (
                  <div className="msg-sources">
                    {t(lang, "chat.sources")}: {m.sources.join(" · ")}
                  </div>
                )}
              </div>
            ))
          )}
          {sending && <div className="msg assistant">{t(lang, "chat.thinking")}</div>}
        </div>

        <div className="chat-input">
          <textarea
            value={input}
            placeholder={t(lang, "chat.placeholder")}
            rows={2}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="button"
            className="button primary"
            disabled={sending || input.trim().length === 0}
            onClick={() => void send()}
          >
            {t(lang, "chat.send")}
          </button>
        </div>
      </section>
    </div>
  );
}

function upsert(sessions: ChatSession[], session: ChatSession): ChatSession[] {
  const next = sessions.some((s) => s.id === session.id)
    ? sessions.map((s) => (s.id === session.id ? session : s))
    : [...sessions, session];
  return next.sort((a, b) => b.updatedAt - a.updatedAt);
}
