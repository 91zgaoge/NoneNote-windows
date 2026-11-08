import { storage } from "./platform/storage.ts";
import { httpTransport } from "./platform/httpTransport.ts";
import { JsonNotePersistence } from "./platform/notePersistence.ts";
import { SettingsStore } from "./platform/settingsStore.ts";
import { FileWikiStore } from "./platform/wikiStore.ts";
import { NoteStore } from "./core/notes/store.ts";
import { SyncManager, type SyncResult } from "./core/sync/manager.ts";
import { WebDavClient } from "./core/sync/webdav.ts";
import { WikiCompileService, WikiScheduler } from "./core/wiki/service.ts";
import { ChatSessionStore } from "./core/chat/store.ts";
import { ChatService } from "./core/chat/service.ts";
import { AttachmentStore, newDiagramAttachment, newLinkAttachment } from "./core/attachment/store.ts";
import { AttachmentSync } from "./core/attachment/sync.ts";
import { AttachmentAnalyzer } from "./core/attachment/analyzer.ts";
import { MemoryStore } from "./core/memory/store.ts";
import { MemoryDreamer, localToday, type ConversationLine } from "./core/memory/dreamer.ts";
import { formatProfile, synthesizeProfile } from "./core/memory/profile.ts";
import { AiClient } from "./core/ai/client.ts";
import { activeProfile, aiVisibleNotes, type NoteDocument } from "./core/types.ts";
import { sha256Sync } from "./core/wiki/text.ts";
import { sha256HexBytes } from "./core/attachment/crypto.ts";
import { excalidrawJson, projectExcalidraw, type ValidElement } from "./core/excalidraw.ts";
import { LinkFetcher, type FetchOutcome } from "./core/web/linkFetcher.ts";
import { webNoteText, describeFetchError } from "./core/web/webNote.ts";
import { dueTodayNotes, localDay, shouldFireDueReminder } from "./core/dueReminder.ts";
import { sendNotification } from "./platform/notify.ts";
import { visionPrep } from "./platform/visionPrep.ts";
import { t } from "./i18n.ts";
import { buildIcs } from "./core/event.ts";
import { blobs } from "./platform/blobStore.ts";

/** One sync-run ledger row (Android keeps the last 10 in Settings). */
export interface SyncRunRow {
  at: number;
  result: SyncResult;
}

const SYNC_RUNS_KEY = "syncRuns";
const SYNC_RUNS_LIMIT = 10;

export interface AppModel {
  noteStore: NoteStore;
  settingsStore: SettingsStore;
  wikiStore: FileWikiStore;
  sync: SyncManager;
  wikiService: WikiCompileService;
  wikiScheduler: WikiScheduler;
  chatStore: ChatSessionStore;
  chatService: ChatService;
  attachmentStore: AttachmentStore;
  attachmentAnalyzer: AttachmentAnalyzer;
  memoryStore: MemoryStore;
  memoryDreamer: MemoryDreamer;
  persistence: JsonNotePersistence;
  subscribeRemoteApplied(fn: () => void): () => void;
  /** Background AI pass for one attachment (call after attach/ingest). */
  analyzeAttachment(id: string): Promise<boolean>;
  /** Fetches a URL into a link attachment and summarizes it. */
  ingestLink(noteId: string, url: string): Promise<{ ok: boolean; detail?: string }>;
  /** Last sync runs, newest first. */
  syncRuns(): Promise<SyncRunRow[]>;
}

let singleton: Promise<AppModel> | null = null;

async function init(): Promise<AppModel> {
  const settingsStore = new SettingsStore(storage);
  await settingsStore.load();

  const persistence = new JsonNotePersistence(storage);
  const noteStore = new NoteStore(persistence);
  await noteStore.loadInitial();

  const wikiStore = new FileWikiStore(storage);
  const attachmentStore = new AttachmentStore(storage, blobs);
  const attachmentSync = new AttachmentSync(
    attachmentStore,
    (cfg) => new WebDavClient(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, httpTransport),
  );
  const chatStore = new ChatSessionStore(storage);
  const memoryStore = new MemoryStore(storage);

  // Privacy gate (Android 1.9.0): hidden notes never reach AI inputs.
  const visible = () => aiVisibleNotes(noteStore.all(), settingsStore.get());

  const memoryDreamer = new MemoryDreamer({
    store: memoryStore,
    notes: visible,
    attachments: () => attachmentStore.loadAll(),
    conversation: () => latestConversation(chatStore),
    llmFactory: () => {
      const p = activeProfile(settingsStore.get());
      return new AiClient(p.baseUrl, p.apiKey, p.model, p.temperature, p.maxTokens, httpTransport);
    },
  });

  // Startup sweep: expire dated facts, drop rows forgotten for 30+ days.
  const now = Date.now();
  void memoryStore.expireBefore(localToday(now), now).catch(() => undefined);
  void memoryStore.pruneForgotten(now - 30 * 24 * 3600 * 1000).catch(() => undefined);

  // Background AI pass over attachments: extraction + summary + vision.
  const attachmentAnalyzer = new AttachmentAnalyzer({
    attachments: attachmentStore,
    loadPayload: (id) => attachmentStore.payload(id),
    llm: () => {
      const p = activeProfile(settingsStore.get());
      if (!p.baseUrl.trim() || !p.model.trim()) return null;
      return new AiClient(p.baseUrl, p.apiKey, p.model, p.temperature, p.maxTokens, httpTransport);
    },
    visionEnabled: () => activeProfile(settingsStore.get()).vision === true,
    visionPrep,
  });
  void attachmentAnalyzer.analyzePending();

  const remoteListeners = new Set<() => void>();

  const chatService = new ChatService({
    notes: visible,
    pages: () => wikiStore.loadPages(),
    settings: () => settingsStore.get(),
    transport: httpTransport,
    memoryBlock: async (question) => {
      const at = Date.now();
      const today = localToday(at);
      const facts = await memoryStore.active(today);
      return formatProfile(synthesizeProfile(facts, at, today, question));
    },
    actions: {
      create: (body, title) => noteStore.create(body, undefined, title),
      createDiagram: (title, rawElements) => {
        // Sync like the other executors: metadata is built synchronously
        // (sha256Sync), the payload write continues in the background.
        // Elements were validated by executeAgentAction before this runs.
        const elements = rawElements as unknown as ValidElement[];
        const json = excalidrawJson(elements, title);
        const bytes = new TextEncoder().encode(json);
        const meta = newDiagramAttachment(
          "pending", // replaced with the real note id below
          (title || "diagram") + ".excalidraw",
          bytes.length,
          sha256Sync(json),
        );
        meta.extractedText = projectExcalidraw(elements);
        const doc: NoteDocument = {
          schemaVersion: 1,
          blocks: [{ type: "canvas", id: "b0", attachmentId: meta.id, title: title || "diagram" }],
        };
        const created = noteStore.create("", undefined, title || undefined, doc);
        meta.noteId = created.id;
        void attachmentStore.savePayload(meta, bytes).then(() =>
          attachmentAnalyzer.analyze(meta.id),
        );
        return created;
      },
      append: (id, text) => {
        const note = noteStore.note(id);
        if (note) noteStore.updateBody(id, (note.body + "\n" + text).trim());
      },
      setColor: (id, color) => noteStore.setColor(id, color),
      setDue: (id, date) => {
        const map = { ...settingsStore.get().noteDueOns, [id]: date };
        void settingsStore.update({ noteDueOns: map });
      },
      addEvent: (title, date, time) => {
        const ics = buildIcs(title, date, time);
        const blob = new Blob([ics], { type: "text/calendar" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `NoneNote-${date}.ics`;
        link.click();
        URL.revokeObjectURL(url);
      },
      archive: (id, archived) => noteStore.setArchived(id, archived),
      remove: (id) => noteStore.delete(id),
    },
  });
  const wikiService = new WikiCompileService({
    notes: visible,
    wikiStore,
    settings: () => settingsStore.get(),
    transport: httpTransport,
    attachments: () => attachmentStore.loadAll(),
    onCompileDone: async () => {
      const result = await memoryDreamer.dream();
      if (result) console.info("memory dream:", result);
    },
  });
  const wikiScheduler = new WikiScheduler(wikiService, settingsStore);
  wikiScheduler.onError = (e) => console.error("scheduled wiki compile failed:", e.message);
  wikiScheduler.start();

  // Sync-run ledger (Android keeps the last 10 runs).
  const syncRunsKey = SYNC_RUNS_KEY;
  const recordRun = async (result: SyncResult, at: number) => {
    try {
      const rows = (await storage.load<SyncRunRow[]>(syncRunsKey)) ?? [];
      rows.unshift({ at, result });
      await storage.save(syncRunsKey, rows.slice(0, SYNC_RUNS_LIMIT));
    } catch {
      /* ledger is best-effort */
    }
  };

  const sync = new SyncManager({
    store: noteStore,
    settings: () => settingsStore.get(),
    sink: {
      async save(deletedJson, knownIdsJson) {
        await settingsStore.update({ syncDeletedJson: deletedJson, syncKnownIdsJson: knownIdsJson });
      },
    },
    clientFactory: (cfg) =>
      new WebDavClient(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, httpTransport),
    onRemoteApplied: () => {
      for (const fn of remoteListeners) fn();
      // Remote rows may bring unsummarized attachments: sweep again.
      void attachmentAnalyzer.analyzePending();
    },
    onRunFinished: (result, at) => void recordRun(result, at),
    attachments: attachmentStore,
    attachmentSync,
  });
  sync.start();

  // Daily due-date reminder: once per local day at/after 08:30 (Android).
  const reminderTick = async () => {
    try {
      const s = settingsStore.get();
      const at = Date.now();
      if (!shouldFireDueReminder(at, s.dueReminderLastDay)) return;
      const today = localDay(at);
      await settingsStore.update({ dueReminderLastDay: today });
      const due = dueTodayNotes(noteStore.all(), s.noteDueOns, today);
      if (due.length === 0) return;
      const lang = s.language;
      const titles = due
        .slice(0, 3)
        .map((n) => n.title || n.body.split(/\r?\n/)[0] || "…")
        .join("、");
      await sendNotification(
        t(lang, "due.reminder.title"),
        t(lang, "due.reminder.body", { count: String(due.length), titles }),
      );
    } catch {
      /* best-effort */
    }
  };
  setInterval(() => void reminderTick(), 60_000);
  void reminderTick();

  return {
    noteStore,
    settingsStore,
    wikiStore,
    sync,
    wikiService,
    wikiScheduler,
    chatStore,
    chatService,
    attachmentStore,
    attachmentAnalyzer,
    memoryStore,
    memoryDreamer,
    persistence,
    subscribeRemoteApplied(fn) {
      remoteListeners.add(fn);
      return () => remoteListeners.delete(fn);
    },
    analyzeAttachment(id) {
      return attachmentAnalyzer.analyze(id);
    },
    async ingestLink(noteId, url) {
      const outcome: FetchOutcome = await new LinkFetcher(httpTransport).fetch(url);
      const note = webNoteText(url, outcome);
      const bytes = new TextEncoder().encode(note.text);
      const meta = newLinkAttachment(noteId, url);
      meta.sha256 = await sha256HexBytes(bytes);
      meta.size = bytes.length;
      await attachmentStore.savePayload(meta, bytes);
      await attachmentStore.setExtractedText(meta.id, note.text);
      await attachmentStore.setParseStatus(meta.id, note.ok ? "ok" : "failed");
      void attachmentAnalyzer.analyze(meta.id);
      return note.ok
        ? { ok: true }
        : { ok: false, detail: !outcome.ok ? describeFetchError(outcome.error) : "no readable content" };
    },
    async syncRuns() {
      return (await storage.load<SyncRunRow[]>(syncRunsKey)) ?? [];
    },
  };
}

/** Last 20 messages of the newest session, with stable ids for incremental dreaming. */
async function latestConversation(chatStore: ChatSessionStore): Promise<ConversationLine[]> {
  const sessions = await chatStore.load();
  const latest = sessions[0];
  if (!latest) return [];
  return latest.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-20)
    .map((m) => ({
      id: `${m.at}:${m.role}:${sha256Sync(m.content)}`,
      text: `${m.role}: ${m.content.slice(0, 500)}`,
    }));
}

export function getAppModel(): Promise<AppModel> {
  if (!singleton) singleton = init();
  return singleton;
}
