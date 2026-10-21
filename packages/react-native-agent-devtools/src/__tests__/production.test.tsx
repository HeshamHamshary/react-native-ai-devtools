import { expect, it, jest } from '@jest/globals';

it('release builds render the app unchanged and never load the runtime', () => {
  const g = globalThis as { __DEV__?: boolean };
  const dev = g.__DEV__;
  g.__DEV__ = false;
  try {
    jest.isolateModules(() => {
      jest.doMock('../AgentDevTools', () => {
        throw new Error('the devtools runtime must not be loaded when __DEV__ is false');
      });
      const lib = require('../index') as typeof import('../index');
      const el = lib.AgentDevTools({ children: 'app' }) as { props: { children: unknown } };
      expect(el.props.children).toBe('app');
      expect(() => lib.reportRoute('Home')).not.toThrow();
    });
  } finally {
    g.__DEV__ = dev;
  }
});
