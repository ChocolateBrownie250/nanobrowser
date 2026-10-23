import { afterEach, describe, expect, it, vi } from 'vitest';
import { dropLive, loadLive, saveLive } from '../models';
import { getLive } from '@src/store/settings';

// storage.session is shared and small: a refused write must not stop a run from starting with the pair the user chose.
function fakeSession() {
  const data: Record<string, unknown> = {};
  const state = { full: false };
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: async (key: string) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
        set: async (items: Record<string, unknown>) => {
          if (state.full) throw new Error('QUOTA_BYTES quota exceeded');
          Object.assign(data, structuredClone(items));
        },
        remove: async (key: string) => void delete data[key],
      },
    },
  });
  return { data, state };
}

const pair = (model: string) => ({ model: { providerId: 'p', model }, reasoning: 'medium' as const });

afterEach(() => vi.unstubAllGlobals());

describe('the live pair when storage.session is full', () => {
  it('keeps the pair in memory instead of failing, and prefers it to the stored one', async () => {
    const { data, state } = fakeSession();
    await saveLive('c1', pair('old'));
    expect(await getLive('c1')).toEqual(pair('old'));
    state.full = true;
    await expect(saveLive('c1', pair('new'))).resolves.toBeUndefined();
    expect(data['nb.live.c1']).toEqual(pair('old'));
    expect(await loadLive('c1')).toEqual(pair('new'));
  });

  it('goes back to storage once a write succeeds, and drops the memory copy with the conversation', async () => {
    const { state } = fakeSession();
    state.full = true;
    await saveLive('c2', pair('a'));
    state.full = false;
    await saveLive('c2', pair('b'));
    state.full = true;
    // The stored copy is the newest now, not the older one kept in memory.
    expect(await loadLive('c2')).toEqual(pair('b'));
    state.full = true;
    await saveLive('c3', pair('x'));
    await dropLive('c3');
    expect(await loadLive('c3')).toBeUndefined();
  });
});
