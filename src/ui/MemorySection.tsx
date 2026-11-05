import { useEffect, useState } from "react";
import type { AppModel } from "../appModel.ts";
import type { MemoryFact } from "../core/memory/types.ts";
import { t, type Lang } from "../i18n.ts";

interface Props {
  model: AppModel;
  lang: Lang;
}

/** "My profile" section: long-term/recent facts, inferred review, Learn now. */
export function MemorySection({ model, lang }: Props) {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [inferred, setInferred] = useState<MemoryFact[]>([]);
  const [learning, setLearning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function reload() {
    const [visible, pending] = await Promise.all([
      model.memoryStore.visible(),
      model.memoryStore.inferred(),
    ]);
    setFacts(visible);
    setInferred(pending);
  }

  useEffect(() => {
    void reload();
    return model.memoryStore.subscribe(() => void reload());
  }, [model]);

  async function learn() {
    setLearning(true);
    setNotice(null);
    try {
      const summary = await model.memoryDreamer.dream();
      if (summary === null) {
        setNotice(t(lang, "memory.failed"));
      } else if (
        summary.inserted + summary.superseded + summary.corroborated + summary.expired === 0
      ) {
        setNotice(t(lang, "memory.nothing"));
      } else {
        setNotice(
          t(lang, "memory.done", {
            inserted: summary.inserted,
            updated: summary.superseded,
            expired: summary.expired,
          }),
        );
      }
      await reload();
    } catch {
      setNotice(t(lang, "memory.failed"));
    } finally {
      setLearning(false);
    }
  }

  async function forget(fact: MemoryFact) {
    if (!window.confirm(t(lang, "memory.forgetConfirm"))) return;
    await model.memoryStore.softForget(fact.id, "declined", Date.now());
    await reload();
  }

  const statics = facts.filter((f) => !f.isInference && f.kind === "static");
  const dynamics = facts.filter((f) => !f.isInference && f.kind === "dynamic");

  return (
    <section className="settings-group">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>{t(lang, "memory.title")}</h3>
        <button
          type="button"
          className="button"
          disabled={learning}
          onClick={() => void learn()}
        >
          {learning ? t(lang, "memory.learning") : t(lang, "memory.learnNow")}
        </button>
      </div>
      {notice && <div className="muted" style={{ marginTop: 6 }}>{notice}</div>}

      {facts.length === 0 && inferred.length === 0 ? (
        <p className="muted">{t(lang, "memory.empty")}</p>
      ) : (
        <>
          {statics.length > 0 && (
            <div className="memory-group">
              <div className="memory-label">{t(lang, "memory.static")}</div>
              {statics.map((f) => (
                <FactRow key={f.id} fact={f} lang={lang} onForget={() => void forget(f)} />
              ))}
            </div>
          )}
          {dynamics.length > 0 && (
            <div className="memory-group">
              <div className="memory-label">{t(lang, "memory.dynamic")}</div>
              {dynamics.map((f) => (
                <FactRow key={f.id} fact={f} lang={lang} onForget={() => void forget(f)} />
              ))}
            </div>
          )}
        </>
      )}

      {inferred.length > 0 && (
        <div className="memory-group inferred">
          <div className="memory-label">{t(lang, "memory.inferred")}</div>
          {inferred.map((f) => (
            <div className="memory-fact" key={f.id}>
              <span>{f.fact}</span>
              <span className="row">
                <button
                  type="button"
                  className="chip"
                  onClick={() => void model.memoryStore.approve(f.id, Date.now())}
                >
                  {t(lang, "memory.approve")}
                </button>
                <button
                  type="button"
                  className="chip danger"
                  onClick={() => void model.memoryStore.decline(f.id, Date.now())}
                >
                  {t(lang, "memory.decline")}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FactRow({
  fact,
  lang,
  onForget,
}: {
  fact: MemoryFact;
  lang: Lang;
  onForget: () => void;
}) {
  return (
    <div className="memory-fact">
      <span>{fact.fact}</span>
      <button type="button" className="chip" onClick={onForget}>
        {t(lang, "memory.forget")}
      </button>
    </div>
  );
}
