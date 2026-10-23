// The cached IndexedDB connection: a failed open or a connection the browser closed is not kept for the life of the page.
import { afterEach, describe, expect, it, vi } from 'vitest';

const open = vi.hoisted(() => vi.fn());
vi.mock('idb', () => ({ openDB: open }));

import { closeDb, db } from '../db';

type Options = { terminated?: () => void; blocking?: () => void };
const fakeDb = () => ({ close: vi.fn() });

afterEach(async () => {
  open.mockReset();
  await closeDb().catch(() => undefined);
});

describe('db()', () => {
  it('opens again after an open that failed', async () => {
    const good = fakeDb();
    open.mockRejectedValueOnce(new Error('UnknownError')).mockResolvedValueOnce(good);
    await expect(db()).rejects.toThrow('UnknownError');
    await expect(db()).resolves.toBe(good);
    // A good connection is shared, not reopened.
    await expect(db()).resolves.toBe(good);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('opens again after the browser terminated the connection', async () => {
    const first = fakeDb();
    const second = fakeDb();
    open.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await expect(db()).resolves.toBe(first);
    (open.mock.calls[0][2] as Options).terminated?.();
    await expect(db()).resolves.toBe(second);
  });

  it('a late failure of an older open does not drop a newer connection', async () => {
    let fail: (e: Error) => void = () => undefined;
    const slow = new Promise<never>((_, reject) => (fail = reject));
    const newer = fakeDb();
    open.mockReturnValueOnce(slow).mockResolvedValueOnce(newer);
    const first = db();
    // blocking() lets a newer version open: the cached open is dropped.
    (open.mock.calls[0][2] as Options).blocking?.();
    await expect(db()).resolves.toBe(newer);
    fail(new Error('late'));
    await expect(first).rejects.toThrow('late');
    await expect(db()).resolves.toBe(newer);
    expect(open).toHaveBeenCalledTimes(2);
  });
});
