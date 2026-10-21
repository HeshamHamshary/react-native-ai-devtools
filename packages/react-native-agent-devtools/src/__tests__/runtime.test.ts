import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { ServerMessage } from 'react-native-agent-devtools-protocol';

const mockStored = new Map<string, string>();
jest.mock('../native', () => {
  const actual = jest.requireActual<typeof import('../native')>('../native');
  return {
    ...actual,
    native: {
      ...actual.native,
      getStoredValue: jest.fn(async (k: string) => mockStored.get(k)),
      setStoredValue: jest.fn(async (k: string, v: string | undefined) => {
        if (v) mockStored.set(k, v);
        else mockStored.delete(k);
      }),
    },
  };
});

// eslint-disable-next-line import/first
import { Runtime } from '../runtime/Runtime';

const serverInfo = { version: '1', agent: { available: false }, repoAccess: 'none', network: 'loopback' } as const;
const deliver = (rt: Runtime, m: ServerMessage) => (rt as unknown as { onServerMessage(m: ServerMessage): void }).onServerMessage(m);
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => mockStored.clear());

describe('pairing token persistence', () => {
  it('stores the token issued on pairing and clears one the server no longer accepts', async () => {
    const rt = new Runtime({ serverUrl: 'ws://localhost:8765' });
    deliver(rt, { type: 'welcome', sessionId: 's', trusted: true, deviceToken: 'tok-1', server: serverInfo });
    await flush();
    expect(mockStored.get('token:ws://localhost:8765')).toBe('tok-1');
    expect(rt.store.get().trusted).toBe(true);

    deliver(rt, { type: 'welcome', sessionId: 's', trusted: false, server: serverInfo });
    await flush();
    expect(mockStored.has('token:ws://localhost:8765')).toBe(false);
    expect(rt.store.get().trusted).toBe(false);
  });

  it('drops the token when the server asks to pair again', async () => {
    mockStored.set('token:ws://localhost:8765', 'old');
    const rt = new Runtime({ serverUrl: 'ws://localhost:8765' });
    (rt as unknown as { deviceToken?: string }).deviceToken = 'old';
    deliver(rt, { type: 'auth.required', reason: 'Enter the pairing code', pairing: true });
    await flush();
    expect(mockStored.size).toBe(0);
    expect(rt.store.get().connection).toBe('pairing-required');
  });
});

describe('chat notices', () => {
  it('shows notices as system lines without ending the turn', () => {
    const rt = new Runtime({ serverUrl: 'ws://localhost:8765' });
    rt.store.set({ chat: 'thinking' });
    deliver(rt, { type: 'chat.notice', level: 'warning', text: 'Answer in your Claude Code terminal.' });
    const last = rt.store.get().messages.at(-1);
    expect(last).toMatchObject({ role: 'system', level: 'warning', text: 'Answer in your Claude Code terminal.' });
    expect(rt.store.get().chat).toBe('thinking');
  });
});
