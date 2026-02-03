// Lightweight WebRTC polyfills for Node using node-datachannel
// Ensures global WebRTC symbols exist for libraries that expect browser APIs.

// CRITICAL: Provide WebSocket implementation for socket.io-client
// In Docker/Node environments without native WebSocket, use 'ws' package
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WsWebSocket = require('ws');

const originalWebSocket = (globalThis as any).WebSocket;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ndcPolyfill = require('node-datachannel/polyfill');
// Handle both CommonJS and ESM-style default export
const webrtc = (ndcPolyfill && ndcPolyfill.default) || ndcPolyfill;

// Core WebRTC classes
(globalThis as any).RTCPeerConnection = (globalThis as any).RTCPeerConnection || webrtc.RTCPeerConnection;
(globalThis as any).RTCSessionDescription =
  (globalThis as any).RTCSessionDescription || webrtc.RTCSessionDescription;
(globalThis as any).RTCIceCandidate = (globalThis as any).RTCIceCandidate || webrtc.RTCIceCandidate;

// CRITICAL: Set WebSocket on BOTH globalThis AND global for Node.js compatibility
// socket.io-client's CJS build uses `global.WebSocket`, not `globalThis.WebSocket`
(globalThis as any).WebSocket = WsWebSocket;
(global as any).WebSocket = WsWebSocket;

// Helpful extras some libs expect
if (webrtc.RTCDataChannel && !(globalThis as any).RTCDataChannel)
  (globalThis as any).RTCDataChannel = webrtc.RTCDataChannel;
if (webrtc.RTCDtlsTransport && !(globalThis as any).RTCDtlsTransport)
  (globalThis as any).RTCDtlsTransport = webrtc.RTCDtlsTransport;
if (webrtc.RTCSctpTransport && !(globalThis as any).RTCSctpTransport)
  (globalThis as any).RTCSctpTransport = webrtc.RTCSctpTransport;
if (webrtc.RTCIceTransport && !(globalThis as any).RTCIceTransport)
  (globalThis as any).RTCIceTransport = webrtc.RTCIceTransport;
if (webrtc.RTCCertificate && !(globalThis as any).RTCCertificate)
  (globalThis as any).RTCCertificate = webrtc.RTCCertificate;
if (webrtc.RTCError && !(globalThis as any).RTCError) (globalThis as any).RTCError = webrtc.RTCError;

// Media types are not the main focus here, but map if present
if (webrtc.MediaStream && !(globalThis as any).MediaStream) (globalThis as any).MediaStream = webrtc.MediaStream;
if (webrtc.MediaStreamTrack && !(globalThis as any).MediaStreamTrack)
  (globalThis as any).MediaStreamTrack = webrtc.MediaStreamTrack;

// Crypto: ensure getRandomValues exists (Node 16+ exposes webcrypto)
if (!(globalThis as any).crypto || typeof (globalThis as any).crypto.getRandomValues !== 'function') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { webcrypto } = require('node:crypto');
    if (webcrypto) (globalThis as any).crypto = webcrypto;
  } catch (err) {
    // Surface a harmless warning so failures to load Node's webcrypto are visible
    // in environment logs (helps debugging in Docker/CI). Keep it non-fatal.
    try {
      console.warn('[WebRTC polyfill] node:crypto.webcrypto not available:', err);
    } catch {
      // ignore if console is unavailable
    }
  }
}

// Base64 helpers some browser-oriented libs rely on
if (typeof (globalThis as any).btoa !== 'function') {
  (globalThis as any).btoa = (str: string) => Buffer.from(str, 'binary').toString('base64');
}
if (typeof (globalThis as any).atob !== 'function') {
  (globalThis as any).atob = (b64: string) => Buffer.from(b64, 'base64').toString('binary');
}

// Minimal navigator shim if ever needed by downstream code
if (!(globalThis as any).navigator) {
  (globalThis as any).navigator = { userAgent: 'node' };
}