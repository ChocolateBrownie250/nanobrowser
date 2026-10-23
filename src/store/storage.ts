// A value in chrome.storage with a cache and listeners, kept live across the extension's pages. Ported from the
// current Nanobrowser's `createStorage` (src/storage/lib/base/base.ts), reduced to what this extension uses.
export type StorageArea = 'local' | 'session';

export interface Storage<D> {
  get(): Promise<D>;
  set(value: D | ((previous: D) => D | Promise<D>)): Promise<void>;
  /** The last value read or written; null before the first read. */
  getSnapshot(): D | null;
  subscribe(listener: () => void): () => void;
}

export function createStorage<D>(
  key: string,
  fallback: D,
  options: { area?: StorageArea; liveUpdate?: boolean; merge?: (stored: unknown) => D } = {},
): Storage<D> {
  const area = options.area ?? 'local';
  let cache: D | null = null;
  let listeners: Array<() => void> = [];
  const read = (raw: unknown): D => (options.merge ? options.merge(raw) : raw === undefined ? fallback : (raw as D));
  const emit = () => listeners.forEach(listener => listener());
  const chromeStorage = () => globalThis.chrome?.storage?.[area];

  const get = async (): Promise<D> => {
    const stored = await chromeStorage()?.get([key]);
    cache = read(stored?.[key]);
    return cache;
  };

  // Writes run one after another, and an updater reads the stored value only when its turn comes, so two sets started
  // together both land (a read-modify-write on a cache would lose one).
  let writes: Promise<void> = Promise.resolve();

  const storage: Storage<D> = {
    get,
    set(value) {
      const write = async () => {
        const next =
          typeof value === 'function' ? await (value as (previous: D) => D | Promise<D>)(await get()) : (value as D);
        cache = next;
        await chromeStorage()?.set({ [key]: next });
        emit();
      };
      const result = writes.then(write);
      // A failed write rejects its own caller only; the next write still runs.
      writes = result.catch(() => undefined);
      return result;
    },
    getSnapshot: () => cache,
    subscribe(listener) {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter(l => l !== listener);
      };
    },
  };

  void get()
    .then(emit)
    .catch(() => undefined);
  if (options.liveUpdate) {
    chromeStorage()?.onChanged.addListener(changes => {
      if (!(key in changes)) return;
      cache = read(changes[key].newValue);
      emit();
    });
  }
  return storage;
}
