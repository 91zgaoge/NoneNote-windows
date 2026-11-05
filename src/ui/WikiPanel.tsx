import { useEffect, useMemo, useRef, useState } from "react";
import type { AppModel } from "../appModel.ts";
import { AiClient } from "../core/ai/client.ts";
import {
  WikiCompiler,
  OVERVIEW_PAGE,
  stalePages,
  type Progress,
  type Summary,
} from "../core/wiki/compiler.ts";
import { activeProfile, extractProfile, type WikiPage } from "../core/types.ts";
import { httpTransport } from "../platform/httpTransport.ts";
import { t, type Lang } from "../i18n.ts";

interface Props {
  model: AppModel;
  lang: Lang;
  revision: number;
}

export function WikiPanel({ model, lang, revision }: Props) {
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [trace, setTrace] = useState<Progress[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadPages = async () => {
    const loaded = await model.wikiStore.loadPages();
    setPages(loaded);
    if (loaded.length > 0 && !loaded.some((p) => p.name === selected)) {
      setSelected(loaded.find((p) => p.name === OVERVIEW_PAGE)?.name ?? loaded[0].name);
    }
  };

  useEffect(() => {
    void loadPages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const settings = model.settingsStore.get();
  const notes = model.noteStore.all();
  const noteSig = notes.map((n) => `${n.id}:${n.modified}`).join("|");
  const page = pages.find((p) => p.name === selected) ?? null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const state = await model.wikiStore.loadState();
      const changed = await stalePages(pages, state, notes);
      if (!cancelled) setStale(changed.size > 0);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, noteSig]);

  const sortedPages = useMemo(
    () =>
      [...pages].sort((a, b) => {
        if (a.name === OVERVIEW_PAGE) return -1;
        if (b.name === OVERVIEW_PAGE) return 1;
        return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
      }),
    [pages],
  );

  async function compile() {
    setNotice(null);
    setSummary(null);
    setTrace([]);
    const profile = activeProfile(settings);
    if (!profile.baseUrl.trim() || !profile.model.trim()) {
      setNotice(t(lang, "wiki.notConfigured"));
      return;
    }
    if (!model.noteStore.all().length) return;

    const llm = new AiClient(
      profile.baseUrl,
      profile.apiKey,
      profile.model,
      profile.temperature,
      profile.maxTokens,
      httpTransport,
    );
    const extract = extractProfile(settings);
    const extractLlm =
      extract.id === profile.id
        ? llm
        : new AiClient(
            extract.baseUrl,
            extract.apiKey,
            extract.model,
            extract.temperature,
            extract.maxTokens,
            httpTransport,
          );

    const controller = new AbortController();
    abortRef.current = controller;
    setCompiling(true);
    try {
      const compiler = new WikiCompiler({
        notesProvider: () => model.noteStore.all(),
        llm,
        extractLlm,
        store: model.wikiStore,
        budget: { maxPagesPerRun: settings.wikiMaxPagesPerRun },
        signal: controller.signal,
        onProgress: (p) => setTrace((prev) => [...prev.slice(-199), p]),
      });
      const result = await compiler.compile();
      setSummary(result);
      await loadPages();
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setNotice(t(lang, "wiki.cancelled"));
        await loadPages();
      } else {
        const detail = e instanceof Error ? e.message : String(e);
        setNotice(t(lang, "wiki.compileFailed", { detail }));
      }
    } finally {
      abortRef.current = null;
      setCompiling(false);
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  function renderBody(body: string) {
    const parts: (string | { link: string })[] = [];
    const re = /\[\[([^\]]+)\]\]/g;
    let last = 0;
    for (const m of body.matchAll(re)) {
      if (m.index! > last) parts.push(body.slice(last, m.index));
      parts.push({ link: m[1].trim() });
      last = m.index! + m[0].length;
    }
    if (last < body.length) parts.push(body.slice(last));
    return parts.map((part, i) =>
      typeof part === "string" ? (
        <span key={i}>{part}</span>
      ) : (
        <button
          key={i}
          type="button"
          className="wikilink"
          onClick={() => {
            if (pages.some((p) => p.name === part.link)) setSelected(part.link);
          }}
        >
          {part.link}
        </button>
      ),
    );
  }

  const lastRows = trace.filter((p) => p.step !== "prepare").slice(-8);

  return (
    <div className="wiki-shell">
      <div className="wiki-header">
        <div>
          <h2>{t(lang, "wiki.title")}</h2>
          <p className="muted">
            {t(lang, "wiki.pages", { n: pages.length })}
            {stale ? ` · ${t(lang, "wiki.stale")}` : ""}
          </p>
        </div>
        <button
          type="button"
          className={compiling ? "button danger" : "button primary"}
          onClick={compiling ? cancel : () => void compile()}
        >
          {compiling ? t(lang, "wiki.cancel") : t(lang, "wiki.compile")}
        </button>
      </div>

      {notice && <div className="banner">{notice}</div>}

      {trace.length > 0 && (
        <div className="trace">
          {lastRows.map((p, i) => (
            <div key={i} className="trace-row">
              <span className={`dot ${p.step}`} />
              <span>
                {p.phase === "EXTRACT"
                  ? t(lang, "wiki.progress.extract")
                  : t(lang, "wiki.progress.pages")}
                {p.label ? ` · ${p.label}` : ""}
                {p.total ? ` (${p.current}/${p.total})` : ""}
                {p.largePrompt ? ` · ${t(lang, "wiki.progress.large")}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {summary && (
        <div className="banner ok">
          <div>
            {t(lang, "wiki.summary", {
              generated: summary.generated,
              seconds: Math.round(summary.durationMs / 100) / 10,
              skipped: summary.skippedUnchanged,
            })}
          </div>
          {summary.pendingPages > 0 && (
            <div>{t(lang, "wiki.pending", { n: summary.pendingPages })}</div>
          )}
          {summary.uncollected > 0 && (
            <div>{t(lang, "wiki.uncollected", { n: summary.uncollected })}</div>
          )}
          <div className="muted">
            {t(lang, "wiki.tokens", {
              prompt: summary.promptTokens,
              completion: summary.completionTokens,
              cached: summary.cachedPromptTokens,
            })}
          </div>
        </div>
      )}

      <div className="wiki-columns">
        <ul className="wiki-list">
          {sortedPages.map((p) => (
            <li key={p.name}>
              <button
                type="button"
                className={`wiki-row${p.name === selected ? " active" : ""}`}
                onClick={() => setSelected(p.name)}
              >
                <span className="title">{p.title}</span>
                <span className="muted">
                  {p.kind} · {p.sourceNoteIds.length}
                </span>
              </button>
            </li>
          ))}
          {sortedPages.length === 0 && <li className="empty">{t(lang, "wiki.empty")}</li>}
        </ul>
        <div className="wiki-page">
          {page ? (
            <>
              <h1>{page.title}</h1>
              <div className="muted">
                {page.kind} · {new Date(page.updatedAt).toLocaleString()}
              </div>
              <div className="wiki-body">{renderBody(page.body)}</div>
            </>
          ) : (
            <div className="empty">{t(lang, "wiki.select")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
