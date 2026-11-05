import { useRef, useState } from "react";
import type { AppModel } from "../appModel.ts";
import type { AppSettings } from "../core/types.ts";
import { activeProfile } from "../core/types.ts";
import { AiClient } from "../core/ai/client.ts";
import { httpTransport } from "../platform/httpTransport.ts";
import { makeBackup, parseBackup } from "../core/backup.ts";
import { uuid } from "../core/text.ts";
import { t, type Lang } from "../i18n.ts";

interface Props {
  model: AppModel;
  lang: Lang;
}

export function SettingsPanel({ model, lang }: Props) {
  const [draft, setDraft] = useState<AppSettings>(() => structuredClone(model.settingsStore.get()));
  const [saved, setSaved] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);

  const profile = activeProfile(draft);

  function patch(p: Partial<AppSettings>) {
    setDraft((d) => ({ ...d, ...p }));
    setSaved(false);
  }

  function patchProfile(p: Partial<typeof profile>) {
    setDraft((d) => ({
      ...d,
      profiles: d.profiles.map((x) => (x.id === profile.id ? { ...x, ...p } : x)),
    }));
    setSaved(false);
    setTestStatus(null);
  }

  async function save() {
    await model.settingsStore.update(draft);
    setSaved(true);
  }

  async function testConnection() {
    setTestStatus("…");
    try {
      const client = new AiClient(
        profile.baseUrl,
        profile.apiKey,
        profile.model,
        profile.temperature,
        profile.maxTokens,
        httpTransport,
      );
      await client.testConnection();
      setTestStatus(t(lang, "ai.test.ok"));
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setTestStatus(t(lang, "ai.test.fail", { detail }));
    }
  }

  async function syncNow() {
    await save();
    await model.sync.sync("manual");
  }

  async function exportBackup() {
    if (!window.confirm(t(lang, "settings.backup.warning"))) return;
    const settings = model.settingsStore.get();
    const [pages, state, chat] = await Promise.all([
      model.wikiStore.loadPages(),
      model.wikiStore.loadState(),
      model.chatStore.load(),
    ]);
    const backup = makeBackup(model.noteStore.all(), settings, pages, state, chat);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `NoneNote-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importBackup(file: File) {
    setNotice(null);
    if (!window.confirm(t(lang, "settings.import.confirm"))) return;
    try {
      const backup = parseBackup(await file.text());
      model.noteStore.replaceAll(backup.notes);
      await model.settingsStore.update(backup.settings);
      const existing = await model.wikiStore.loadPages();
      const names = new Set(backup.pages.map((p) => p.name));
      for (const p of existing) {
        if (!names.has(p.name)) await model.wikiStore.deletePage(p.name);
      }
      for (const p of backup.pages) await model.wikiStore.savePage(p);
      await model.wikiStore.saveState(backup.state);
      await model.chatStore.save(backup.chat);
      setDraft(structuredClone(model.settingsStore.get()));
      setNotice(
        t(lang, "settings.import.done", {
          notes: backup.notes.length,
          pages: backup.pages.length,
        }),
      );
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setNotice(t(lang, "settings.import.fail", { detail }));
    }
  }

  const sync = model.sync.lastSyncResult;
  const syncText =
    !model.settingsStore.get().webdavUrl.trim()
      ? t(lang, "sync.not_configured")
      : sync === null
        ? t(lang, "sync.never")
        : sync.kind === "ok"
          ? t(lang, "sync.ok", { n: sync.noteCount })
          : sync.kind === "failed"
            ? t(lang, "sync.failed", { detail: sync.detail })
            : t(lang, "sync.not_configured");

  return (
    <div className="settings-shell">
      <div className="settings-header">
        <h2>{t(lang, "settings.title")}</h2>
        <div className="row">
          <span className="muted">{syncText}</span>
          <button type="button" className="button" onClick={() => void save()}>
            {t(lang, "settings.save")}
          </button>
          {saved && <span className="muted">{t(lang, "settings.saved")}</span>}
        </div>
      </div>

      {notice && <div className="banner">{notice}</div>}

      <section className="settings-group">
        <h3>{t(lang, "settings.language")}</h3>
        <select
          value={draft.language}
          onChange={(e) => patch({ language: e.target.value === "zh" ? "zh" : "en" })}
        >
          <option value="en">English</option>
          <option value="zh">简体中文</option>
        </select>
      </section>

      <section className="settings-group">
        <h3>{t(lang, "sync.title")}</h3>
        <label>
          {t(lang, "sync.url")}
          <input
            value={draft.webdavUrl}
            placeholder="https://dav.example.com/remote.php/dav/files/me"
            onChange={(e) => patch({ webdavUrl: e.target.value })}
          />
        </label>
        <label>
          {t(lang, "sync.user")}
          <input value={draft.webdavUser} onChange={(e) => patch({ webdavUser: e.target.value })} />
        </label>
        <label>
          {t(lang, "sync.pass")}
          <input
            type="password"
            value={draft.webdavPass}
            onChange={(e) => patch({ webdavPass: e.target.value })}
          />
        </label>
        <div className="row">
          <label>
            {t(lang, "sync.mode")}
            <select value={draft.syncMode} onChange={(e) => patch({ syncMode: e.target.value })}>
              <option value="both">{t(lang, "sync.mode.both")}</option>
              <option value="upload">{t(lang, "sync.mode.upload")}</option>
              <option value="download">{t(lang, "sync.mode.download")}</option>
            </select>
          </label>
          <label>
            {t(lang, "sync.deletion")}
            <select
              value={draft.syncDeletion}
              onChange={(e) => patch({ syncDeletion: e.target.value })}
            >
              <option value="both">{t(lang, "sync.deletion.both")}</option>
              <option value="local_off">{t(lang, "sync.deletion.local_off")}</option>
              <option value="remote_off">{t(lang, "sync.deletion.remote_off")}</option>
            </select>
          </label>
        </div>
        <button type="button" className="button" onClick={() => void syncNow()}>
          {t(lang, "sync.now")}
        </button>
      </section>

      <section className="settings-group">
        <h3>{t(lang, "ai.title")}</h3>
        <div className="row">
          <label>
            {t(lang, "ai.profile")}
            <select
              value={draft.activeProfileId}
              onChange={(e) => patch({ activeProfileId: e.target.value })}
            >
              {draft.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button"
            onClick={() => {
              const id = uuid();
              const p = {
                id,
                label: `Profile ${draft.profiles.length + 1}`,
                baseUrl: "",
                apiKey: "",
                model: "",
                temperature: 0.7,
                maxTokens: 2048,
              };
              patch({ profiles: [...draft.profiles, p], activeProfileId: id });
            }}
          >
            {t(lang, "ai.addProfile")}
          </button>
          <button
            type="button"
            className="button"
            disabled={draft.profiles.length <= 1}
            onClick={() => {
              const profiles = draft.profiles.filter((p) => p.id !== profile.id);
              patch({ profiles, activeProfileId: profiles[0].id });
            }}
          >
            {t(lang, "ai.removeProfile")}
          </button>
        </div>
        <label>
          {t(lang, "ai.baseUrl")}
          <input
            value={profile.baseUrl}
            placeholder="https://api.openai.com/v1"
            onChange={(e) => patchProfile({ baseUrl: e.target.value })}
          />
        </label>
        <label>
          {t(lang, "ai.apiKey")}
          <input
            type="password"
            value={profile.apiKey}
            onChange={(e) => patchProfile({ apiKey: e.target.value })}
          />
        </label>
        <div className="row">
          <label>
            {t(lang, "ai.model")}
            <input
              value={profile.model}
              placeholder="gpt-4o-mini"
              onChange={(e) => patchProfile({ model: e.target.value })}
            />
          </label>
          <label>
            {t(lang, "ai.temperature")}
            <input
              type="number"
              step="0.1"
              value={profile.temperature}
              onChange={(e) => patchProfile({ temperature: Number(e.target.value) })}
            />
          </label>
          <label>
            {t(lang, "ai.maxTokens")}
            <input
              type="number"
              value={profile.maxTokens}
              onChange={(e) => patchProfile({ maxTokens: Number(e.target.value) })}
            />
          </label>
        </div>
        <div className="row">
          <label>
            {t(lang, "ai.extractModel")}
            <select
              value={draft.wikiExtractProfileId}
              onChange={(e) => patch({ wikiExtractProfileId: e.target.value })}
            >
              <option value="">{t(lang, "ai.followActive")}</option>
              {draft.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="button" onClick={() => void testConnection()}>
            {t(lang, "ai.test")}
          </button>
          {testStatus && <span className="muted">{testStatus}</span>}
        </div>
      </section>

      <section className="settings-group">
        <h3>{t(lang, "wiki.title")}</h3>
        <label>
          {t(lang, "settings.wikiBudget")}
          <input
            type="number"
            min={0}
            value={draft.wikiMaxPagesPerRun}
            onChange={(e) => patch({ wikiMaxPagesPerRun: Number(e.target.value) })}
          />
        </label>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={draft.wikiAutoCompile}
            onChange={(e) => patch({ wikiAutoCompile: e.target.checked })}
          />
          {t(lang, "settings.autoCompile")}
        </label>
        {draft.wikiAutoCompile && (
          <label>
            {t(lang, "settings.autoCompileTime")}
            <input
              type="time"
              value={minutesToTime(draft.wikiAutoCompileMinutes)}
              onChange={(e) => patch({ wikiAutoCompileMinutes: timeToMinutes(e.target.value) })}
            />
          </label>
        )}
        <p className="muted">{t(lang, "settings.autoCompileHint")}</p>
      </section>

      <section className="settings-group">
        <h3>{t(lang, "settings.backup")}</h3>
        <p className="muted">{t(lang, "settings.backup.warning")}</p>
        <div className="row">
          <button type="button" className="button" onClick={() => void exportBackup()}>
            {t(lang, "settings.export")}
          </button>
          <button type="button" className="button" onClick={() => importRef.current?.click()}>
            {t(lang, "settings.import")}
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importBackup(file);
              e.target.value = "";
            }}
          />
        </div>
      </section>
    </div>
  );
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 8 * 60;
  return Math.min(1439, Math.max(0, h * 60 + m));
}
