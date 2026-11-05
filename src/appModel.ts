import { storage } from "./platform/storage.ts";
import { httpTransport } from "./platform/httpTransport.ts";
import { JsonNotePersistence } from "./platform/notePersistence.ts";
import { SettingsStore } from "./platform/settingsStore.ts";
import { FileWikiStore } from "./platform/wikiStore.ts";
import { NoteStore } from "./core/notes/store.ts";
import { SyncManager } from "./core/sync/manager.ts";
import { WebDavClient } from "./core/sync/webdav.ts";

export interface AppModel {
  noteStore: NoteStore;
  settingsStore: SettingsStore;
  wikiStore: FileWikiStore;
  sync: SyncManager;
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
  });
  sync.start();

  return {
    noteStore,
    settingsStore,
    wikiStore,
    sync,
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
