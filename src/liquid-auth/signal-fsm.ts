export type State = 'idle' | 'ready' | 'processing' | 'closed' | 'error';

export type Event = { type: string; payload?: any };

import { fromBase64Url, toBase64URL } from '@algorandfoundation/liquid-client';
import axios from 'axios';

export type SessionContext = any; // keep loose to fit existing session shape

export type ActionFn = (ctx: SessionContext, ev?: Event) => void;

export interface Transition {
  next?: State;
  action?: ActionFn;
}

export class SignalSessionMachine {
  state: State;
  ctx: SessionContext;
  transitions: Record<string, Record<string, Transition>>;

  constructor(initial: State, ctx: SessionContext, transitions: Record<string, Record<string, Transition>>) {
    this.state = initial;
    this.ctx = ctx;
    this.transitions = transitions;
  }

  handle(ev: Event) {
    const table = this.transitions[this.state] || {};
    const t = table[ev.type] || table['*'] || (this.transitions['*'] && this.transitions['*'][ev.type]);
    if (!t) return;
    try {
      if (t.action) t.action(this.ctx, ev);
      if (t.next) this.state = t.next;
    } catch (err) {
      // best-effort: mark error and surface to ctx
      try {
        this.ctx.state = 'error';
      } catch { }
    }
  }
}

// Small helper to create a machine for a session with a basic send-queue and ping handling.
export function createSignalSessionMachine(session: SessionContext) {
  // ensure queue exists
  if (!session.sendQueue) session.sendQueue = [] as any[];

  // If a sponsor URL is available, attempt to populate sponsorAddress from Sponsor /info.
  if (!session.sponsorAddress && (session.sponsorUrl || process.env.SPONSOR_URL)) {
    (async () => {
      try {
        const sponsorUrl: string = session.sponsorUrl || process.env.SPONSOR_URL!;
        const r = await axios.get(sponsorUrl.replace(/\/$/, '') + '/info');
        if (r?.data?.address) {
          session.sponsorAddress = r.data.address;
          try { console.debug('[SignalFSM] resolved sponsorAddress from /info', session.sponsorAddress); } catch { }
        } else if (r?.data?.public_key_base64) {
          session.sponsorPubKeyB64 = r.data.public_key_base64;
          try { console.debug('[SignalFSM] resolved sponsorPubKeyB64 from /info', session.sponsorPubKeyB64); } catch { }
        }
      } catch (e) {
        // ignore — validation will catch missing sponsorAddress later
      }
    })();
  }

  const sendIfPossible: ActionFn = (ctx) => {
    const dc: any = ctx.dataChannel;
    if (!dc || typeof dc.send !== 'function') return;
    while (ctx.sendQueue && ctx.sendQueue.length) {
      const item = ctx.sendQueue.shift();
      try {
        // Debug: log outgoing items so we can trace what's sent over the DC
        try { console.debug('[SignalFSM] sending on dataChannel', typeof item === 'string' ? item : JSON.stringify(item)); } catch { }
        // Extra: if we're sending the sponsor address, emit a clear marker
        try { if (item && typeof item === 'object' && (item as any).address) console.debug('[SignalFSM] sending sponsor address over DC', (item as any).address); } catch { }
        dc.send(typeof item === 'string' ? item : JSON.stringify(item));
      } catch (e) {
        // On failure, push back and stop flushing.
        console.warn('[SignalFSM] dataChannel send failed, requeueing', e?.message || e);
        ctx.sendQueue.unshift(item);
        break;
      }
    }
  };

  const sendPing: ActionFn = (ctx) => {
    const addr = (ctx as any).sponsorAddress;
    const payload = addr ? { type: 'address', address: addr } : { type: 'pong', ts: Date.now() };
    const dc: any = ctx.dataChannel;
    if (dc && typeof dc.send === 'function') {
      try {
        try { if (payload && (payload as any).my_address) console.debug('[SignalFSM] ping handler sending my_address', (payload as any).my_address); } catch { }
        dc.send(JSON.stringify(payload));
        ctx.pendingPing = false;
      } catch (e) {
        ctx.pendingPing = true;
        ctx.sendQueue.push(payload);
      }
    } else {
      ctx.pendingPing = true;
      ctx.sendQueue.push(payload);
    }

    // If we don't yet have a sponsor address, try to resolve it via Sponsor /info
    try {
      const addrPresent = !!(ctx as any).sponsorAddress;
      const sponsorUrl = (ctx as any).sponsorUrl || process.env.SPONSOR_URL;
      if (!addrPresent && sponsorUrl) {
        // fire-and-forget: when resolved, enqueue the address for immediate send
        axios.get(sponsorUrl.replace(/\/$/, '') + '/info')
          .then(r => {
            const addr = r?.data?.address;
            if (addr) {
              try { console.debug('[SignalFSM] resolved sponsorAddress from /info in ping', addr); } catch { }
              (ctx as any).sponsorAddress = addr;
              // enqueue address and attempt immediate flush (use canonical shape)
              try { ctx.sendQueue.unshift({ type: 'address', address: addr }); } catch { }
              try { if (ctx.dataChannel && ctx.dataChannel.readyState === 'open') sendIfPossible(ctx); } catch { }
            } else if (r?.data?.public_key_base64) {
              try { console.debug('[SignalFSM] resolved sponsorPubKeyB64 from /info in ping'); } catch { }
              (ctx as any).sponsorPubKeyB64 = r.data.public_key_base64;
            }
          })
          .catch(err => {
            try { console.debug('[SignalFSM] Sponsor /info failed in ping', err?.message || err); } catch { }
          });
      }
    } catch (e) { /* swallow */ }
  };

  // Focused transitions for data-channel protocol only. The machine does NOT
  // manage socket lifecycle or pre/post WebRTC signaling. It assumes the
  // data channel will be attached to `ctx.dataChannel` and will receive
  // `dc-open` / `dc-message` events from the caller.
  const transitions: Record<string, Record<string, Transition>> = {
    // before the data channel is usable
    idle: {
      // peer-resolved may attach a dc prior to open
      'peer-resolved': {
        action: (ctx, ev) => {
          ctx.dataChannel = ev?.payload?.dc ?? ctx.dataChannel;
          // If we already received a link-message (wallet) before the
          // data channel attached, proactively send a ping so the peer
          // knows we're present. Also flush the send queue if the
          // channel is already open.
          try {
            // Always send a ping when a peer resolves. If we already
            // know the sponsor address, enqueue it for the peer.
            sendPing(ctx);
            if ((ctx as any).sponsorAddress) {
              try { console.debug('[SignalFSM] enqueueing sponsorAddress on peer-resolved', (ctx as any).sponsorAddress); } catch { }
              ctx.sendQueue.push({ type: 'address', address: (ctx as any).sponsorAddress });
            }
            if (ctx.dataChannel && ctx.dataChannel.readyState === 'open') sendIfPossible(ctx);
          } catch { }
        },
      },
      // when the dc becomes open, move to ready and flush queue
      'dc-open': {
        next: 'ready',
        action: (ctx) => {
          // If we already know the sponsor address, enqueue and flush it immediately
          if ((ctx as any).sponsorAddress) {
            try { console.debug('[SignalFSM] enqueueing sponsorAddress on dc-open', (ctx as any).sponsorAddress); ctx.sendQueue.push({ type: 'address', address: (ctx as any).sponsorAddress }); } catch { }
          }
          sendIfPossible(ctx);
        },
      },
      // link-message is allowed but only updates context
      'link-message': {
        action: (ctx, ev) => {
          ctx.lastActivity = Date.now();
          ctx.wallet = ev?.payload?.wallet ?? ctx.wallet;
        },
      },
    },
    // channel ready to send/receive application protocol messages
    ready: {
      'dc-message': {
        action: (ctx, ev) => {
          ctx.lastActivity = Date.now();
          // parse and dispatch application-level message types
          try {
            const raw = ev?.payload;
            let parsed: any = raw;
            if (typeof raw === 'string') parsed = JSON.parse(raw);
            // handle common types: ping, sign-request, sign-response, etc.
            // Support peers that send a bare bytesToSign object without a `type`.
            // Treat messages containing `bytesToSign` as `sign-request` for convenience.
            const t = parsed?.type ?? (parsed?.bytesToSign ? 'sign-request' : undefined);
            if (!t) return;
            const handler = (readyMessageHandlers as any)[t];
            if (typeof handler === 'function') handler(ctx, { type: t, payload: parsed });
          } catch (e) {
            // ignore parse errors; higher layers can validate
            console.log("error: ", e);
          }
        },
      },
      'dc-open': {
        action: (ctx) => {
          sendIfPossible(ctx);
        },
      },
    },
    // processing: machine is handling a sign-request or similar synchronous flow
    processing: {
      'dc-message': {
        action: (ctx, ev) => {
          ctx.lastActivity = Date.now();
          // remain flexible: reuse ready handlers
          try {
            const raw = ev?.payload;
            let parsed: any = raw;
            if (typeof raw === 'string') parsed = JSON.parse(raw);
            const t = parsed?.type;
            if (!t) return;
            const handler = (readyMessageHandlers as any)[t];
            if (typeof handler === 'function') handler(ctx, { type: t, payload: parsed });
          } catch { }
        },
      },
    },
    error: {
      '*': { action: (ctx) => { } },
    },
    closed: {
      '*': { action: (ctx) => { } },
    },
  };

  // Application-level message handlers used by the machine when in `ready`/`processing`.
  // Keep these small; they may be extended to implement signing flows.
  const readyMessageHandlers: Record<string, ActionFn> = {
    ping: (ctx) => {
      ctx.lastActivity = Date.now();
      const dc: any = ctx.dataChannel;
      const addr = (ctx as any).sponsorAddress;
      const payload = addr ? { my_address: addr } : { type: 'pong', ts: Date.now() };
      if (dc && typeof dc.send === 'function') {
        try {
          dc.send(JSON.stringify(payload));
        } catch {
          // enqueue on failure
          ctx.sendQueue.push(payload);
        }
      } else {
        // enqueue until the channel is ready
        ctx.sendQueue.push(payload);
      }
    },
    'sign-request': (ctx, ev) => {
      ctx.lastActivity = Date.now();
      const payload = ev?.payload ?? {};
      const id = payload.id;
      // dedupe: avoid processing the same sign-request twice
      try {
        if (!((ctx as any)._inflightSignIds)) (ctx as any)._inflightSignIds = new Set<string>();
        const inflight: Set<string> = (ctx as any)._inflightSignIds;
        if (id && inflight.has(id)) {
          try { console.debug('[SignalFSM] duplicate sign-request ignored', id); } catch { }
          return;
        }
        if (id) inflight.add(id);
      } catch { }

      // acknowledge receipt immediately
      ctx.sendQueue.push({ type: 'sign-ack', id });

      // Async signing flow: try to sign the provided prefix/tx and enqueue response
      (async () => {
        try {
          // Prefer Sponsor HTTP signing backend. Caller may set session.sponsorUrl.
          const sponsorUrl: string | undefined = (ctx as any).sponsorUrl || process.env.SPONSOR_URL;
          if (!sponsorUrl) throw new Error('Sponsor signing backend not configured');

          // Pawn acts as a thin proxy: Sponsor performs validation and signing.
          const prefix: any = payload.bytesToSign;
          if (!prefix) throw new Error('No bytesToSign provided to sign');
          const prefixBytes: Uint8Array = fromBase64Url(prefix);

          // Request Sponsor to sign the provided transaction bytes. Sponsor will call Vault transit.
          const inputB64 = Buffer.from(prefixBytes).toString('base64');
          const signReq = {
            key: 'sponsor',
            transit_path: 'pawn/managers',
            input_b64: inputB64,
          };
          const sponsorEndpoint = sponsorUrl.replace(/\/$/, '') + '/sign';
          const sponsorResp = await axios.post(sponsorEndpoint, signReq, { headers: { 'Content-Type': 'application/json' } });
          const vaultSig: string | undefined = sponsorResp?.data?.signature;
          if (!vaultSig) throw new Error('Sponsor did not return a signature');
          console.log("vaultSig: ", vaultSig);
          const parts = vaultSig.split(':');
          const b64Part = parts.length >= 3 ? parts[2] : parts[parts.length - 1];
          const sigBuf = Buffer.from(b64Part, 'base64');
          // Use the provided helper to convert raw signature bytes to base64url
          const sigBytes = Uint8Array.from(sigBuf);
          const sigB64url = toBase64URL(sigBytes);
          console.debug('[SignalFSM] signature created', { id });
          console.debug('[SignalFSM] enqueueing sign-response', { id });
          // Send the canonical base64url signature to the peer with type and id for correlation
          ctx.sendQueue.push({ type: 'sign-response', id, signature: sigB64url });
          if (ctx.dataChannel && ctx.dataChannel.readyState === 'open') sendIfPossible(ctx);
        } catch (e) {
          // signal failure to caller; preserve Sponsor-provided error details when available
          const axiosErr = e as any;
          const sponsorErr = axiosErr?.response?.data;
          const details = sponsorErr?.error ? `${sponsorErr.error}${sponsorErr.details ? `: ${sponsorErr.details}` : ''}` : undefined;
          ctx.sendQueue.push({ type: 'sign-response', id, error: details || String(e) });
          if (ctx.dataChannel && ctx.dataChannel.readyState === 'open') sendIfPossible(ctx);
        } finally {
          try { if (id && (ctx as any)._inflightSignIds) (ctx as any)._inflightSignIds.delete(id); } catch { }
        }
      })();
    },
    'sign-response': (ctx, ev) => {
      ctx.lastActivity = Date.now();
      // store result or pass to waiter
      ctx.lastSignResponse = ev?.payload;
    },
  } as Record<string, ActionFn>;

  // Always start the protocol machine in `idle` so it can accept
  // link-message / peer-resolved events regardless of the external
  // session lifecycle state (which is managed by the caller).
  const m = new SignalSessionMachine('idle', session, transitions);
  return m;
}
