/**
 * The Sentry wrapper must be a strict no-op without SENTRY_DSN (dev/test/CI) and
 * must attach tenant/request tags when enabled. @sentry/node is mocked; the module
 * is re-required per test so its one-time `enabled` flag resets.
 */
const initMock = jest.fn();
const captureMock = jest.fn();
const closeMock = jest.fn().mockResolvedValue(true);
const scope = { setTag: jest.fn(), setContext: jest.fn() };
const withScopeMock = jest.fn((cb: (s: typeof scope) => void) => cb(scope));

jest.mock('@sentry/node', () => ({
  init: (...a: unknown[]) => initMock(...a),
  captureException: (...a: unknown[]) => captureMock(...a),
  withScope: (cb: (s: typeof scope) => void) => withScopeMock(cb),
  close: (...a: unknown[]) => closeMock(...a),
}));

type SentryModule = typeof import('./sentry');

describe('sentry helper', () => {
  beforeEach(() => {
    jest.resetModules();
    initMock.mockClear();
    captureMock.mockClear();
    withScopeMock.mockClear();
    scope.setTag.mockClear();
    scope.setContext.mockClear();
    delete process.env.SENTRY_DSN;
  });

  it('is a no-op without SENTRY_DSN', async () => {
    const s: SentryModule = await import('./sentry');
    expect(s.initSentry('api')).toBe(false);
    expect(s.isSentryEnabled()).toBe(false);
    expect(initMock).not.toHaveBeenCalled();
    s.captureError(new Error('x'), { schoolId: 'a' });
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('initialises with the DSN, server name and environment', async () => {
    process.env.SENTRY_DSN = 'https://key@example.com/1';
    process.env.NODE_ENV = 'production';
    const s: SentryModule = await import('./sentry');
    expect(s.initSentry('worker')).toBe(true);
    expect(s.isSentryEnabled()).toBe(true);
    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: 'https://key@example.com/1', serverName: 'worker', environment: 'production' }),
    );
    process.env.NODE_ENV = 'test';
  });

  it('captures with tenant/request tags when enabled', async () => {
    process.env.SENTRY_DSN = 'https://key@example.com/1';
    const s: SentryModule = await import('./sentry');
    s.initSentry('api');
    s.captureError(new Error('boom'), {
      schoolId: 'sch', userId: 'usr', requestId: 'req', method: 'POST', url: '/api/v1/x',
    });
    expect(scope.setTag).toHaveBeenCalledWith('schoolId', 'sch');
    expect(scope.setTag).toHaveBeenCalledWith('userId', 'usr');
    expect(scope.setTag).toHaveBeenCalledWith('requestId', 'req');
    expect(scope.setContext).toHaveBeenCalledWith('request', { method: 'POST', url: '/api/v1/x' });
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('wraps a non-Error value into an Error', async () => {
    process.env.SENTRY_DSN = 'https://key@example.com/1';
    const s: SentryModule = await import('./sentry');
    s.initSentry('api');
    s.captureError('plain string');
    expect(captureMock).toHaveBeenCalledWith(expect.any(Error));
  });

  it('init is idempotent', async () => {
    process.env.SENTRY_DSN = 'https://key@example.com/1';
    const s: SentryModule = await import('./sentry');
    s.initSentry('api');
    s.initSentry('api');
    expect(initMock).toHaveBeenCalledTimes(1);
  });
});
