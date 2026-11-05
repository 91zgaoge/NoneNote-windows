import { storage } from "./platform/storage.ts";
import { httpTransport } from "./platform/httpTransport.ts";
import { JsonNotePersistence } from "./platform/notePersistence.ts";
import { SettingsStore } from "./platform/settingsStore.ts";
import { FileWikiStore } from "./platform/wikiStore.ts";
import { NoteStore } from "./core/notes/store.ts";
import { SyncManager } from "./core/sync/manager.ts";
import { WebDavClient } from "./core/sync/webdav.ts";
import { WikiCompileService, WikiScheduler } from "./core/wiki/service.ts";
import { ChatSessionStore } from "./core/chat/store.ts";
import { ChatService } from "./core/chat/service.ts";
import { AttachmentStore } from "./core/attachment/store.ts";
import { AttachmentSync } from "./core/attachment/sync.ts";
import { MemoryStore } from "./core/memory/store.ts";
import { MemoryDreamer, localToday, type ConversationLine } from "./core/memory/dreamer.ts";
import { formatProfile, synthesizeProfile } from "./core/memory/profile.ts";
import { AiClient } from "./core/ai/client.ts";
import { activeProfile } from "./core/types.ts";
import { sha256Sync } from "./core/wiki/text.ts";
import { buildIcs } from "./core/event.ts";
import { blobs } from "./platform/blobStore.ts";

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
  memoryStore: MemoryStore;
  memoryDreamer: MemoryDreamer;
  persistence: JsonNotePersistence;
  subscribeRemoteApplied(fn: () => void): () => void;
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
  const memoryDreamer = new MemoryDreamer({
    store: memoryStore,
    notes: () => noteStore.all(),
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

  const remoteListeners = new Set<() => void>();

  const chatService = new ChatService({
    notes: () => noteStore.all(),
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
    notes: () => noteStore.all(),
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
    },
    attachments: attachmentStore,
    attachmentSync,
  });
  sync.start();

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
    memoryStore,
    memoryDreamer,
    persistence,
    subscribeRemoteApplied(fn) {
      remoteListeners.add(fn);
      return () => remoteListeners.delete(fn);
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
