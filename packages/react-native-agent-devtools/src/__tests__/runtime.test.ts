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

describe('resuming after a reload', () => {
  it('rebuilds the transcript from chat.history', () => {
    const rt = new Runtime({ serverUrl: 'ws://localhost:8765' });
    deliver(rt, {
      type: 'chat.history',
      events: [
        { type: 'chat.user', id: 'm1', text: 'Why?', attachment: 'PrimaryButton "Log in"' },
        { type: 'chat.tool', turnId: 'm1', toolId: 't1', name: 'mobile_inspect', phase: 'start', summary: 'Inspect selected element' },
        { type: 'chat.tool', turnId: 'm1', toolId: 't1', name: 'mobile_inspect', phase: 'end', ok: true, durationMs: 40, detail: 'e5 button' },
        { type: 'chat.text', turnId: 'm1', text: 'It is covered by #promo-overlay.' },
        { type: 'chat.done', turnId: 'm1', ok: true },
      ],
    });
    const msgs = rt.store.get().messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'tool', 'assistant']);
    expect(msgs[0]).toMatchObject({ text: 'Why?', attachment: 'PrimaryButton "Log in"' });
    expect(msgs[1]!.tool).toMatchObject({ phase: 'end', ok: true, detail: 'e5 button' });
    expect(rt.store.get().chat).toBe('idle');
  });
});

describe('connection help', () => {
  it('explains how to reach the server from a physical device after repeated failures', () => {
    const rt = new Runtime({ serverUrl: 'ws://192.168.1.20:8765' });
    const conn = rt as unknown as { onConnState(s: string, d?: string): void };
    conn.onConnState('closed', 'code 1006');
    expect(rt.store.get().connectionHint).toBeUndefined();
    conn.onConnState('closed');
    conn.onConnState('closed');
    expect(rt.store.get().connectionHint).toMatch(/--lan and pair this app/);
    conn.onConnState('open');
    expect(rt.store.get().connectionHint).toBeUndefined();
  });
});
