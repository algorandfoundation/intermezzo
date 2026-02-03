import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignalClient } from '@algorandfoundation/liquid-client';
import axios from 'axios';
import { createSignalSessionMachine } from './signal-fsm';
import { VaultService } from '../vault/vault.service';

type ClientType = 'offer' | 'answer';

export interface ManagedSession {
  requestId: string;
  url: string;
  type: ClientType;
  client: any; // SignalClient instance
  createdAt: number;
  lastActivity: number;
  expiresAt: number;
  state: 'starting' | 'awaiting-answer' | 'active' | 'closed' | 'error';
}

@Injectable()
export class SignalClientManager implements OnApplicationShutdown {
  private readonly logger = new Logger(SignalClientManager.name);
  private readonly sessions = new Map<string, ManagedSession>();

  // TTLs (tune as needed)
  private readonly awaitingAnswerTtlMs = 1000 * 60 * 5; // 5 minutes
  private readonly activeIdleTtlMs = 1000 * 60 * 30; // 30 minutes
  private readonly absoluteCapMs = 1000 * 60 * 60; // 60 minutes

  private pruneTimer: NodeJS.Timeout | null = null;
  // Cache manager resolution promises to avoid repeated Vault calls
  private managerResolutionCache = new Map<string, Promise<{ address: string; pub?: Uint8Array; vaultBackend?: VaultService }>>();

  constructor(private readonly vaultService?: VaultService, private readonly configService?: ConfigService) {
    // Periodic prune sweep
    this.pruneTimer = setInterval(() => this.pruneExpired(), 60_000);
  }

  generateRequestId(): string {
    return SignalClient.generateRequestId();
  }

  async startOffer(url: string, requestId?: string, rtcConfig?: any): Promise<ManagedSession> {
    const id = requestId || this.generateRequestId();
    const now = Date.now();
    const session: ManagedSession = {
      requestId: id,
      url,
      type: 'offer',
      client: null,
      createdAt: now,
      lastActivity: now,
      expiresAt: now + this.awaitingAnswerTtlMs,
      state: 'starting',
    };

    // Extra, non-typed fields we may attach later:
    // (session as any).wallet: string
    // (session as any).dataChannel: RTCDataChannel | any
    // (session as any).pendingPing: boolean
    (session as any).pendingPing = false;


    // Resolve sponsor address by querying Sponsor /info first (no Vault tokens required).
    try {
      const sponsorUrl = this.configService?.get?.('SPONSOR_URL') || process.env.SPONSOR_URL;
      if (sponsorUrl) {
        try {
          this.logger.debug(`Attempting to resolve sponsor via HTTP at ${sponsorUrl}`);
          const r = await axios.get((sponsorUrl as string).replace(/\/$/, '') + '/info');
          this.logger.debug(`Sponsor /info response for id=${id}: ${JSON.stringify(r.data).substring(0, 200)}`);
          if (r?.data?.address) {
            (session as any).sponsorAddress = r.data.address;
            if (r?.data?.public_key_base64) (session as any).sponsorPubKeyB64 = r.data.public_key_base64;
            this.logger.debug(`Resolved sponsor via /info for id=${id}: ${(session as any).sponsorAddress}`);
          }
        } catch (err: any) {
          this.logger.debug(`Sponsor HTTP resolution failed for id=${id}: ${err?.message || err}`);
        }
      }

      // If sponsor wasn't resolved via HTTP, fall back to Vault-based resolution
      if (!(session as any).sponsorAddress) {
        const token: string | undefined = (session as any).vaultToken;
        const cacheKey = token || '__no_token__';
        if (!this.managerResolutionCache.has(cacheKey)) {
          const p = (async (): Promise<{ address: string; pub?: Uint8Array; vaultBackend?: VaultService }> => {
            if (this.vaultService && token) {
              const pub = await this.vaultService.getManagerPublicKey(token);
              const { AlgorandEncoder } = await import('@algorandfoundation/algo-models');
              const addr = new AlgorandEncoder().encodeAddress(Buffer.from(pub));
              return { address: addr, pub: Uint8Array.from(pub), vaultBackend: this.vaultService };
            }
            throw new Error('Vault not configured or manager token missing');
          })();
          this.managerResolutionCache.set(cacheKey, p);
        }

        const resolved = await this.managerResolutionCache.get(cacheKey)!;
        (session as any).sponsorAddress = resolved.address;
        if (resolved.pub) (session as any).sponsorPubKeyB64 = Buffer.from(resolved.pub).toString('base64');
        if (resolved.vaultBackend) (session as any).vaultBackend = resolved.vaultBackend;
        try { this.logger.debug(`Resolved sponsor via Vault for id=${id}: ${resolved.address}`); } catch { }
      }
    } catch (e) {
      this.logger.warn(`Manager address resolution failed for id=${id}: ${e?.message || e}`);
    }

    this.logger.debug(`startOffer called with url=${url}, id=${id}`);
    this.logger.debug(`startOffer: creating offer session id=${id}, rtcConfigSet=${!!rtcConfig}`);
    try {
      this.logger.debug(`Instantiating SignalClient for url=${url}`);
      const client = new SignalClient(url);
      session.client = client;

      // Attach a small FSM to the session to coordinate incoming messages and sends
      const machine = createSignalSessionMachine(session);
      (session as any).machine = machine;

      // Socket wiring: keep handlers but remove verbose diagnostics.
      const socket = (client as any).socket;
      if (socket) {
        // Connection events are functional; only surface problems.
        socket.on('connect', () => {
          // no-op: connection acknowledged elsewhere
        });
        socket.on('connect_error', (err: any) => {
          this.logger.warn(`Socket CONNECT_ERROR for id=${id}: ${err?.message || err}`);
        });
        socket.on('disconnect', (reason: any) => {
          this.logger.warn(`Socket DISCONNECT for id=${id}: ${reason}`);
          // mark session errored so it will be pruned/closed
          try {
            session.state = 'error';
            session.expiresAt = Date.now();
          } catch {
            // ignore if session unavailable for some reason
          }
        });
      } else {
        this.logger.warn(`No socket found on client for url=${url}, id=${id}`);
      }

      // Listen for link-message event
      if (typeof client.on === 'function') {
        client.on('link-message', (msg: any) => {
          this.logger.debug(`link-message for id=${id}: ${JSON.stringify(msg)}`);
          try {
            session.lastActivity = Date.now();
            const m = (session as any).machine;
            if (m && typeof m.handle === 'function') m.handle({ type: 'link-message', payload: msg });
          } catch (e: any) {
            this.logger.warn(`link-message handling failed for id=${id}: ${e?.message || e}`);
          }
        });
      }

      // Wait for socket to connect before calling peer to ensure link event isn't lost
      this.logger.debug(`Checking socket connection before calling peer for id=${id}`);
      const maxWaitMs = 5000;
      const startTime = Date.now();
      while (!(client as any).socket?.connected) {
        if (Date.now() - startTime > maxWaitMs) {
          throw new Error('Socket failed to connect after 5 seconds');
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      this.logger.debug(`Socket confirmed connected for id=${id}, waiting 500ms for socket to stabilize`);
      // Extra delay to ensure socket event handlers are fully wired on server side
      await new Promise(resolve => setTimeout(resolve, 500));
      this.logger.debug(`Socket stabilized for id=${id}, proceeding with peer()`);

      // DIAGNOSTIC: Listen for ALL socket events to see what's being received
      socket.onAny((eventName: string, ...args: any[]) => {
        this.logger.debug(`Socket received event: ${eventName} ${JSON.stringify(args).substring(0, 200)}`);
      });

      // Begin signaling as answerer - backend waits for mobile's offer, then creates answer
      // type='offer' means we RECEIVE an offer and CREATE an answer
      // liquid-client automatically calls link() internally when type='offer'
      if (typeof client.peer === 'function') {
        this.logger.debug(`Calling client.peer with id=${id}, type=offer (wait for mobile's offer)`);
        this.logger.log(`startOffer: invoking client.peer(id=${id}, type=offer)`);

        client.peer(id, 'offer', rtcConfig)
          .then((dc: any) => {
            this.logger.debug(`client.peer resolved for id=${id}`);
            this.logger.log(
              `[SignalClientManager] client.peer resolved for id=${id}, hasDc=${!!dc}, ` +
              `dcType=${dc?.constructor?.name ?? typeof dc}`,
            );
            session.state = 'awaiting-answer';
            // Store data channel if available and notify machine
            if (dc) {
              (session as any).dataChannel = dc;
              try {
                this.logger.debug(
                  `DataChannel attached for id=${id}, readyState=${dc.readyState}, ` +
                  `label=${dc.label ?? 'n/a'}`,
                );
              } catch {
                // best-effort logging only
              }

              // Inform the machine that peer resolved with a DC
              try {
                const m = (session as any).machine;
                // Diagnostic: log that we're notifying the FSM and whether sponsorAddress is present
                try { this.logger.debug(`Notifying FSM peer-resolved for id=${id}, sponsorAddress=${(session as any).sponsorAddress}`); } catch { }
                if (m && typeof m.handle === 'function') m.handle({ type: 'peer-resolved', payload: { dc } });
              } catch { /* swallow machine errors */ }

              // Attach message handler to delegate to machine
              dc.onmessage = (event: any) => {
                this.logger.debug(`DataChannel message for id=${id}: ${event.data}`);
                session.lastActivity = Date.now();
                const m = (session as any).machine;
                if (m && typeof m.handle === 'function') m.handle({ type: 'dc-message', payload: event.data });
              };

              // Attach open/close handlers if supported so we know if the channel ever becomes usable
              try {
                (dc as any).onopen = () => {
                  this.logger.debug(`DataChannel onopen for id=${id}, readyState=${dc.readyState}`);
                  const m = (session as any).machine;
                  if (m && typeof m.handle === 'function') m.handle({ type: 'dc-open' });
                };
                (dc as any).onclose = () => {
                  this.logger.debug(
                    `DataChannel onclose for id=${id}, readyState=${dc.readyState}`,
                  );
                  const m = (session as any).machine;
                  if (m && typeof m.handle === 'function') m.handle({ type: 'dc-close' });
                };
                (dc as any).onerror = (err: any) => {
                  this.logger.warn(`[SignalClientManager] DataChannel onerror for id=${id}: ${err?.message || err}`);
                  const m = (session as any).machine;
                  if (m && typeof m.handle === 'function') m.handle({ type: 'dc-error', payload: err });
                };
              } catch {
                // ignore; some implementations may not expose these
              }
            }
          })
          .catch((err: any) => {
            this.logger.error(`[SignalClientManager] client.peer rejected for id=${id}: ${err?.message || err}`);
            session.state = 'error';
            session.expiresAt = Date.now();
          });
      } else {
        this.logger.debug('client.peer is not a function');
      }

      // Wire generic events if available
      if (typeof client.on === 'function') {
        this.logger.debug('Wiring client events');
        client.on('open', () => {
          this.logger.debug(`client.on('open') fired for id=${id}`);
          session.state = 'active';
          session.lastActivity = Date.now();
          session.expiresAt = Math.min(session.createdAt + this.absoluteCapMs, Date.now() + this.activeIdleTtlMs);
        });
        client.on('message', () => {
          this.logger.debug(`client.on('message') fired for id=${id}`);
          session.lastActivity = Date.now();
        });
        client.on('close', () => {
          this.logger.debug(`client.on('close') fired for id=${id}`);
          session.state = 'closed';
          this.sessions.delete(id);
        });
        client.on('error', (err: any) => {
          this.logger.warn(`client.on error ${id}: ${err?.message || err}`);
          session.state = 'error';
          session.expiresAt = Date.now();
        });
      } else {
        this.logger.debug('client.on is not a function');
      }

      // Only track the session if startup succeeded
      this.sessions.set(id, session);
      this.logger.debug(`Session ${id} added to sessions map`);
    } catch (err: any) {
      this.logger.error(`Failed to start offer for ${id}: ${err?.message || err}`);
      throw err;
    }

    this.logger.debug(`Returning session for id=${id}`);
    return session;
  }

  get(requestId: string): ManagedSession | undefined {
    const s = this.sessions.get(requestId);
    if (!s) return undefined;
    if (Date.now() > s.expiresAt) {
      this.close(requestId);
      return undefined;
    }
    return s;
  }

  close(requestId: string): boolean {
    const s = this.sessions.get(requestId);
    if (!s) return false;
    try {
      if (s.client && typeof s.client.close === 'function') s.client.close();
    } catch (err: any) {
      this.logger.warn(`Error closing client ${requestId}: ${err?.message || err}`);
    }
    this.sessions.delete(requestId);
    return true;
  }

  listActiveIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  pruneExpired(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions.entries()) {
      const absoluteCap = s.createdAt + this.absoluteCapMs;
      const deadline = Math.min(absoluteCap, s.expiresAt);
      if (now > deadline) {
        this.logger.debug(`Pruning session ${id}`);
        this.close(id);
      }
    }
  }

  onApplicationShutdown(signal?: string) {
    this.logger.log(`Shutting down SignalClientManager (${signal || 'SIG'})`);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    for (const id of this.sessions.keys()) this.close(id);
  }
}
