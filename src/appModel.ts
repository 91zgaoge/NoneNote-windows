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
  const remoteListeners = new Set<() => void>();
  const attachmentStore = new AttachmentStore(storage, blobs);
  const attachmentSync = new AttachmentSync(
    attachmentStore,
    (cfg) => new WebDavClient(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, httpTransport),
  );
  const chatStore = new ChatSessionStore(storage);
  const chatService = new ChatService({
    notes: () => noteStore.all(),
    pages: () => wikiStore.loadPages(),
    settings: () => settingsStore.get(),
    transport: httpTransport,
    actions: {
      create: (body, title) => noteStore.create(body, undefined, title),
      append: (id, text) => {
        const note = noteStore.note(id);
        if (note) noteStore.updateBody(id, (note.body + "\n" + text).trim());
      },
      setColor: (id, color) => noteStore.setColor(id, color),
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
    persistence,
    subscribeRemoteApplied(fn) {
      remoteListeners.add(fn);
      return () => remoteListeners.delete(fn);
    },
  };
}

export function getAppModel(): Promise<AppModel> {
  if (!singleton) singleton = init();
  return singleton;
}
