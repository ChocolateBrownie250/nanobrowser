// Settings → Data: the Privacy choices, how much is stored, where to delete one conversation, the conversations the old Nanobrowser left
// (export or delete), and Delete everything, which the worker carries out so that running tasks stop first.
import { useEffect, useState } from 'react';
import { Button, Notice } from '@src/ui/components';
import { SettingsCard } from './SettingsCard';
import { PrivacyCard } from './PrivacyCard';
import { t } from '@src/ui/i18n';
import { DATA_REQUEST } from '@src/ui/protocol';
import { useStorage } from '@src/ui/hooks';
import { deleteOldChats, oldChatsFilename, oldChatsMarkdown, oldChatsStorage, readOldChats } from '@src/store/legacy';
import type { OldChat } from '@src/store/legacy';

const NO_CHATS: OldChat[] = [];

/** Saves the old conversations as one Markdown file, through an anchor's download. */
async function exportOldChats(): Promise<void> {
  const now = Date.now();
  const url = URL.createObjectURL(new Blob([oldChatsMarkdown(await readOldChats(), now)], { type: 'text/markdown' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: oldChatsFilename(now) });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The old version's conversations, shown while there are any. */
function PreviousCard({ onDeleted }: { onDeleted: () => void }) {
  const chats = useStorage(oldChatsStorage, NO_CHATS);
  const [confirming, setConfirming] = useState(false);
  if (!chats.length) return null;
  return (
    <SettingsCard
      title={t('data.previous')}
      description={t(chats.length === 1 ? 'data.previousHintOne' : 'data.previousHint', { count: chats.length })}
      className="flex flex-col gap-2">
      {confirming ? (
        <div className="flex gap-2">
          <Button
            variant="danger"
            onClick={() =>
              void deleteOldChats().then(() => {
                setConfirming(false);
                onDeleted();
              })
            }>
            {t('data.previousConfirm')}
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button onClick={() => void exportOldChats()}>{t('history.export')}</Button>
          <Button variant="danger" onClick={() => setConfirming(true)}>
            {t('history.delete')}
          </Button>
        </div>
      )}
    </SettingsCard>
  );
}

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Asks the worker to delete everything. Resolves with the worker's error text (or an empty one) when it did not succeed. */
async function deleteEverything(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const reply = (await chrome.runtime.sendMessage({ type: DATA_REQUEST, op: 'delete-all' })) as
      { ok?: boolean; error?: unknown } | undefined;
    if (reply?.ok === true) return { ok: true };
    return { ok: false, error: typeof reply?.error === 'string' ? reply.error : '' };
  } catch (error) {
    // The worker stopped before it answered, or could not be reached.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Delete everything: a confirmation, then the notice that it was done, or why it was not (it can be tried again). */
export function DeleteEverythingCard({ onDone }: { onDone?: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setFailure(null);
    const result = await deleteEverything();
    setBusy(false);
    if (result.ok) {
      setConfirming(false);
      setDeleted(true);
      onDone?.();
    } else {
      setDeleted(false);
      setFailure(result.error);
    }
  };
  return (
    <SettingsCard title={t('data.everything')} description={t('data.everythingHint')} className="flex flex-col gap-2">
      {deleted ? <Notice tone="ok">{t('data.deleted')}</Notice> : null}
      {failure !== null ? (
        <Notice tone="error">
          {failure ? t('data.deleteFailed', { error: failure }) : t('data.deleteFailedPlain')}
        </Notice>
      ) : null}
      {confirming ? (
        <div className="flex gap-2">
          <Button variant="danger" disabled={busy} onClick={() => void run()}>
            {t('data.everythingConfirm')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : (
        <Button
          className="self-start"
          variant="danger"
          onClick={() => {
            setDeleted(false);
            setFailure(null);
            setConfirming(true);
          }}>
          {t('data.everything')}
        </Button>
      )}
    </SettingsCard>
  );
}

export function DataSection() {
  const [used, setUsed] = useState<number | null>(null);
  const measure = () =>
    void navigator.storage
      ?.estimate()
      .then(e => setUsed(e.usage ?? null))
      .catch(() => setUsed(null));
  useEffect(measure, []);
  return (
    <div className="flex flex-col gap-6">
      <h2 className="sr-only">{t('settings.nav.data')}</h2>
      <SettingsCard
        title={t('data.usage')}
        description={used === null ? '…' : t('data.usageLine', { used: size(used) })}
      />
      <SettingsCard title={t('data.conversations')} description={t('data.conversationsHint')} />
      <PreviousCard onDeleted={measure} />
      <PrivacyCard />
      <DeleteEverythingCard onDone={measure} />
    </div>
  );
}
