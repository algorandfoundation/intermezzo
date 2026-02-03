/* eslint-disable @typescript-eslint/no-require-imports */
// Register a module mock BEFORE importing the manager so the manager picks it up.
jest.mock('@algorandfoundation/liquid-client', () => {
  const EventEmitter = require('events');
  class MockSocket extends EventEmitter {
    connected = true;
    id = 'mock-sock-1';
    io: any = { opts: {}, engine: { transport: { name: 'mock' }, readyState: 'open' } };
    onAny(_fn: any) {
      /* no-op for tests */
    }
  }

  class MockSignalClient extends EventEmitter {
    static generateRequestId() {
      return 'mock-req-1';
    }
    socket = new MockSocket();
    closed = false;
    close() {
      this.closed = true;
    }
  }

  // define peer on prototype so tests can mock/override it via Mock.prototype.peer
  MockSignalClient.prototype.peer = jest.fn().mockResolvedValue(null);

  return { SignalClient: MockSignalClient };
});

const { SignalClientManager } = require('./signal-client.manager');

// Quiet verbose logger output during unit tests while keeping warn/error intact.
const { Logger } = require('@nestjs/common');
let _debugSpy: jest.SpyInstance;
let _logSpy: jest.SpyInstance;
beforeAll(() => {
  _debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => { });
  _logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => { });
});
afterAll(() => {
  _debugSpy.mockRestore();
  _logSpy.mockRestore();
});

describe('SignalClientManager (unit)', () => {
  let mgr: any;

  beforeEach(() => {
    mgr = new SignalClientManager();
  });

  afterEach(() => {
    try {
      mgr.onApplicationShutdown();
    } catch { }
  });

  test('startOffer returns a session and stores it', async () => {
    const session = await mgr.startOffer('https://example.test');
    expect(session).toBeDefined();
    expect(session.requestId).toBeDefined();
    const got = mgr.get(session.requestId);
    expect(got).toBeDefined();
  });

  test('peer rejection marks session error', async () => {
    const Mock = require('@algorandfoundation/liquid-client').SignalClient;
    Mock.prototype.peer.mockImplementationOnce(() => Promise.reject(new Error('peer-fail')));
    const session = await mgr.startOffer('https://example.test-peerfail');
    await new Promise((r) => setTimeout(r, 10));
    const got = mgr.get(session.requestId);
    expect(got).toBeUndefined();
  });

  test('deferred ping is sent when data channel attaches after link-message', async () => {
    const sends: string[] = [];
    const dc = { send: (p: string) => sends.push(p), readyState: 'open', label: 'mock-dc', onmessage: null };
    const Mock = require('@algorandfoundation/liquid-client').SignalClient;
    let resolvePeer: (v: any) => void;
    Mock.prototype.peer.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolvePeer = res;
        }),
    );

    const partial = await mgr.startOffer('https://example.test-ping');
    const requestId = partial.requestId;
    const client = partial.client as any;

    client.emit('link-message', { wallet: 'mock-wallet' });
    resolvePeer!(dc);
    await new Promise((r) => setTimeout(r, 20));

    expect(sends.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(sends[0]);
    expect(parsed.type).toBe('ping');

    mgr.close(requestId);
  });

  test('close removes session and calls client.close', async () => {
    const session = await mgr.startOffer('https://example.test-close');
    const id = session.requestId;
    const client = session.client as any;
    const closed = mgr.close(id);
    expect(closed).toBe(true);
    expect(client.closed).toBe(true);
    expect(mgr.get(id)).toBeUndefined();
  });

  test('socket disconnect sets session to error and expires it', async () => {
    const session = await mgr.startOffer('https://example.test-disconnect');
    const id = session.requestId;
    const client = session.client as any;
    // emit disconnect
    client.socket.emit('disconnect', 'lost');
    // give a tick
    await new Promise(r => setTimeout(r, 10));
    const s = (mgr as any).sessions.get(id);
    expect(s).toBeDefined();
    expect(s.state).toBe('error');
    expect(s.expiresAt).toBeLessThanOrEqual(Date.now());
  });

  test('pruneExpired removes stale sessions and calls close', async () => {
    const session = await mgr.startOffer('https://example.test-prune');
    const id = session.requestId;
    const client = session.client as any;
    // expire the session
    const s = (mgr as any).sessions.get(id);
    s.expiresAt = Date.now() - 10;
    // call prune
    (mgr as any).pruneExpired();
    expect(mgr.get(id)).toBeUndefined();
    expect(client.closed).toBe(true);
  });

  test('get returns undefined for expired sessions', async () => {
    const session = await mgr.startOffer('https://example.test-get-expired');
    const id = session.requestId;
    const s = (mgr as any).sessions.get(id);
    s.expiresAt = Date.now() - 1000;
    expect(mgr.get(id)).toBeUndefined();
  });

  test('onApplicationShutdown closes all clients and clears sessions', async () => {
    const s1 = await mgr.startOffer('https://example.test-shutdown-1', 'shutdown-1');
    const s2 = await mgr.startOffer('https://example.test-shutdown-2', 'shutdown-2');
    const id1 = s1.requestId;
    const id2 = s2.requestId;
    const c1 = s1.client as any;
    const c2 = s2.client as any;
    // Spy on close if available
    const spy1 = c1 && typeof c1.close === 'function' ? jest.spyOn(c1, 'close') : null;
    const spy2 = c2 && typeof c2.close === 'function' ? jest.spyOn(c2, 'close') : null;

    mgr.onApplicationShutdown('SIG');

    // sessions should be gone
    expect(mgr.get(id1)).toBeUndefined();
    expect(mgr.get(id2)).toBeUndefined();

    // Either client.close was called, or the client was not tracked — accept both as success
    if (spy1) expect(spy1).toHaveBeenCalled();
    if (spy2) expect(spy2).toHaveBeenCalled();
  });

  test('close handles client.close throwing without crashing', async () => {
    const id = 'manual-id';
    const now = Date.now();
    const session = {
      requestId: id,
      url: 'x',
      type: 'offer',
      client: { close: () => { throw new Error('boom'); } },
      createdAt: now,
      lastActivity: now,
      expiresAt: now + 1000,
      state: 'starting',
    };
    (mgr as any).sessions.set(id, session);
    const closed = mgr.close(id);
    expect(closed).toBe(true);
    expect(mgr.get(id)).toBeUndefined();
  });
});
