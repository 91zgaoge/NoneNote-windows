import { useEffect, useMemo, useRef, useState } from "react";
import type { AppModel } from "../appModel.ts";
import { OVERVIEW_PAGE, stalePages, type Progress, type Summary } from "../core/wiki/compiler.ts";
import { activeProfile, type WikiPage } from "../core/types.ts";
import { t, type Lang } from "../i18n.ts";

interface Props {
  model: AppModel;
  lang: Lang;
  revision: number;
}

export function WikiPanel({ model, lang, revision }: Props) {
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(model.wikiService.running());
  const [trace, setTrace] = useState<Progress[]>([]);
  const [summary, setSummary] = useState<Summary | null>(model.wikiService.lastSummary);
  const [notice, setNotice] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [stale, setStale] = useState(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const langRef = useRef(lang);
  langRef.current = lang;

  const loadPages = async () => {
    const loaded = await model.wikiStore.loadPages();
    setPages(loaded);
    const current = selectedRef.current;
    if (loaded.length > 0 && !loaded.some((p) => p.name === current)) {
      setSelected(loaded.find((p) => p.name === OVERVIEW_PAGE)?.name ?? loaded[0].name);
    }
  };

  useEffect(() => {
    void loadPages();
    const unProgress = model.wikiService.subscribeProgress((p) =>
      setTrace((prev) => [...prev.slice(-199), p]),
    );
    const unSummary = model.wikiService.subscribeSummary((s) => {
      setSummary(s);
      void loadPages();
    });
    const unState = model.wikiService.subscribeState(setCompiling);
    const unError = model.wikiService.subscribeError((e) => {
      const language = langRef.current;
      if (e.name === "AbortError") setNotice(t(language, "wiki.cancelled"));
      else if (e.name === "WikiNotConfiguredError")
        setNotice(t(language, "wiki.notConfigured"));
      else setNotice(t(language, "wiki.compileFailed", { detail: e.message }));
    });
    return () => {
      unProgress();
      unSummary();
      unState();
      unError();
    };
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
  }, [pages, noteSig, revision]);

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
    try {
      await model.wikiService.compile({ background: false, userInstruction: instruction });
    } catch {
      // The service broadcasts the error; the subscription localizes it.
    }
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
  const profile = activeProfile(settings);
  const configured = !!profile.baseUrl.trim() && !!profile.model.trim();

  return (
    <div className="wiki-shell">
      <div className="wiki-header">
        <div>
          <h2>{t(lang, "wiki.title")}</h2>
          <p className="muted">
            {t(lang, "wiki.pages", { n: pages.length })}
            {stale ? ` · ${t(lang, "wiki.stale")}` : ""}
            {settings.wikiAutoCompile
              ? ` · ${t(lang, "wiki.auto", {
                  time: formatMinutes(settings.wikiAutoCompileMinutes),
                })}`
              : ""}
          </p>
        </div>
        <button
          type="button"
          className={compiling ? "button danger" : "button primary"}
          disabled={!compiling && !configured}
          onClick={compiling ? () => model.wikiService.cancel() : () => void compile()}
        >
          {compiling ? t(lang, "wiki.cancel") : t(lang, "wiki.compile")}
        </button>
      </div>
      <div className="row">
        <input
          className="link-ingest"
          placeholder={t(lang, "wiki.instruction.placeholder")}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </div>

      {!configured && <div className="banner">{t(lang, "wiki.notConfigured")}</div>}
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

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
