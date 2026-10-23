// Saving a file the agent made: the offscreen document makes a blob URL, the worker downloads it with chrome.downloads,
// follows the download to its end, then has the URL revoked (at the latest after 10 minutes) and closes the offscreen
// document when it holds none.
const OFFSCREEN = 'offscreen.html';
const held = new Set<string>();
/** The name asked for each blob URL being saved. */
const naming = new Map<string, string>();

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: [chrome.offscreen.Reason.BLOBS],
    justification: 'Make blob URLs for files the agent saves',
  });
}

async function revoke(url: string): Promise<void> {
  if (!held.delete(url)) return;
  const answer = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', url }).catch(() => null)) as {
    held?: number;
  } | null;
  if (!held.size && (answer?.held ?? 0) === 0) await chrome.offscreen.closeDocument().catch(() => undefined);
}

/** A blob URL for the content, made in the offscreen document. */
export async function blobUrl(content: string, mimeType: string): Promise<string> {
  await ensureOffscreen();
  const answer = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'blob-url', content, mimeType })) as {
    url: string;
  };
  held.add(answer.url);
  // Revoked anyway after 10 minutes.
  setTimeout(() => void revoke(answer.url), 10 * 60_000);
  return answer.url;
}

export interface SavedFile {
  downloadId: number;
  /** The name the file got: a number is added rather than overwrite a file. */
  name: string;
  state: 'complete' | 'interrupted';
  error?: string;
}

/** How long a download may take to end: a Save as dialog waits for a person, so it gets longer. */
const DOWNLOAD_CLOCK_MS = 2 * 60_000;
const SAVE_AS_CLOCK_MS = 10 * 60_000;

type Ended = { state: 'complete' | 'interrupted'; error?: string };

/**
 * Waits for a download to complete or be interrupted. It also ends when `signal` aborts (Stop) or the clock runs out;
 * the download is then cancelled and the wait reports it as interrupted. The listener is always removed.
 */
function follow(downloadId: number, signal?: AbortSignal, clockMs = DOWNLOAD_CLOCK_MS): Promise<Ended> {
  return new Promise(resolve => {
    const done = (state: Ended['state'], error?: string) => {
      chrome.downloads.onChanged.removeListener(listener);
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(clock);
      resolve({ state, ...(error ? { error } : {}) });
    };
    const stop = (error: string) => {
      void Promise.resolve(chrome.downloads.cancel(downloadId)).catch(() => undefined);
      done('interrupted', error);
    };
    const onAbort = () => stop('USER_CANCELED');
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId || !delta.state?.current) return;
      if (delta.state.current === 'complete') done('complete');
      else if (delta.state.current === 'interrupted') done('interrupted', delta.error?.current);
    };
    chrome.downloads.onChanged.addListener(listener);
    signal?.addEventListener('abort', onAbort, { once: true });
    const clock = setTimeout(() => stop('TIMED_OUT'), clockMs);
    if (signal?.aborted) return onAbort();
    // It may have ended before the listener was added.
    void chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item?.state === 'complete') done('complete');
      else if (item?.state === 'interrupted') done('interrupted', item.error);
    });
  });
}

/**
 * Chrome ignores the `filename` given to chrome.downloads.download while any extension listens to
 * onDeterminingFilename, and then names the file after the blob URL (a random id). So while a file is being saved,
 * Nanobrowser listens too and suggests the name itself. It stops listening once its files are named, before any Save as
 * dialog: an empty answer still counts as a choice in Chrome and would override other extensions' names.
 */
function suggestName(
  item: chrome.downloads.DownloadItem,
  suggest: (suggestion?: chrome.downloads.FilenameSuggestion) => void,
): void {
  const filename = item.byExtensionId === chrome.runtime.id ? naming.get(item.url) : undefined;
  if (!filename) return suggest();
  suggest({ filename, conflictAction: 'uniquify' });
  stopNaming(item.url);
}

function stopNaming(url: string): void {
  naming.delete(url);
  if (!naming.size) chrome.downloads.onDeterminingFilename.removeListener(suggestName);
}

/** Whether `saved` is `asked` with a number Chrome added, as in `prices (1).csv` for `prices.csv`. */
export function isNumberedCopy(saved: string, asked: string): boolean {
  const dot = asked.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [asked.slice(0, dot), asked.slice(dot)] : [asked, ''];
  const middle = saved.slice(stem.length, saved.length - ext.length);
  return saved.startsWith(stem) && saved.endsWith(ext) && /^ \(\d+\)$/.test(middle);
}

/**
 * Saves text as a file in the Downloads folder. Never overwrites: Chrome adds a number to the name. With `saveAs`,
 * Chrome's own dialog lets the user choose where. Stop (`signal`) and a clock end the wait and cancel the download.
 */
export async function saveText(
  file: { filename: string; content: string; mimeType: string },
  saveAs = false,
  signal?: AbortSignal,
): Promise<SavedFile> {
  const url = await blobUrl(file.content, file.mimeType);
  naming.set(url, file.filename);
  chrome.downloads.onDeterminingFilename.addListener(suggestName);
  const cancelled: SavedFile = { downloadId: -1, name: file.filename, state: 'interrupted', error: 'USER_CANCELED' };
  try {
    if (signal?.aborted) return cancelled;
    const starting = chrome.downloads.download({
      url,
      filename: file.filename,
      conflictAction: 'uniquify',
      saveAs,
    });
    // The call itself can wait for the Save as dialog, so Stop must be able to end it too.
    const started = await Promise.race([
      starting,
      new Promise<null>(resolve => signal?.addEventListener('abort', () => resolve(null), { once: true })),
    ]);
    if (started === null) {
      void starting.then(id => chrome.downloads.cancel(id)).catch(() => undefined);
      return cancelled;
    }
    const downloadId = started;
    const end = await follow(downloadId, signal, saveAs ? SAVE_AS_CLOCK_MS : DOWNLOAD_CLOCK_MS);
    const [item] = await chrome.downloads.search({ id: downloadId });
    const name = item?.filename ? item.filename.split(/[/\\]/).pop()! : file.filename;
    return { downloadId, name, ...end };
  } finally {
    stopNaming(url);
    await revoke(url);
  }
}
