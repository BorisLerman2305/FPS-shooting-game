// Peer-to-peer networking via PeerJS (WebRTC).
//
// Topology: STAR. The host owns the room and every client opens a single data
// channel directly to the host. Clients never connect to each other — if they
// need to talk, the host relays.
//
// Why PeerJS: it bundles a free public broker so no backend is required. If the
// broker (or NAT traversal) ever fails, swap PeerJS for a different transport
// without touching the rest of the game.

import { Peer } from 'peerjs';

const ROOM_PREFIX = 'fpsg-';

function genRoomCode() {
  // 5-char alphabet without ambiguous chars (no 0/O/1/I/L)
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

// A peer that hasn't sent ANY message in this many milliseconds is treated
// as a zombie connection — we close it locally so the lobby roster stays
// accurate even when WebRTC silently dies.
const HEARTBEAT_INTERVAL_MS = 3000;
const HEARTBEAT_TIMEOUT_MS = 9000;

class Net extends EventTarget {
  constructor() {
    super();
    this.peer = null;
    this.connections = new Map(); // peerId → DataConnection (host: 1 per client; client: just the host)
    this.role = null;             // 'host' | 'client' | null
    this.myId = null;
    this.roomCode = null;
    this.profile = { name: 'Player', color: '#ffd54a', fav: 'pistol' };
    this.peerProfiles = new Map(); // peerId → { name, color, fav }
    this.lastSeen = new Map();    // peerId → timestamp of last received message
    this._heartbeatTimer = null;
  }

  setProfile(p) { Object.assign(this.profile, p); }

  isHost()      { return this.role === 'host'; }
  isClient()    { return this.role === 'client'; }
  isConnected() { return this.peer !== null && this.role !== null; }
  peerCount()   { return this.connections.size; }
  getPeers()    { return [...this.connections.keys()]; }
  getPeerProfile(id) { return this.peerProfiles.get(id); }

  // ─── Hosting ────────────────────────────────────────────────────────────
  async host() {
    await this.leave();
    this.role = 'host';
    return this._tryHost(0);
  }
  _tryHost(attempt) {
    return new Promise((resolve, reject) => {
      const code = genRoomCode();
      const peerId = ROOM_PREFIX + code;
      this.peer = new Peer(peerId, { debug: 0 });
      this.peer.on('open', id => {
        this.myId = id;
        this.roomCode = code;
        resolve(code);
      });
      this.peer.on('connection', conn => this._wireIncoming(conn));
      this.peer.on('error', err => {
        // Retry with a different code if this one's already taken
        if (err && err.type === 'unavailable-id' && attempt < 3) {
          try { this.peer.destroy(); } catch {}
          this.peer = null;
          this._tryHost(attempt + 1).then(resolve, reject);
        } else if (err && err.type === 'unavailable-id') {
          reject(new Error('לא הצלחתי להקצות חדר. נסה שוב.'));
        } else {
          // 'open' may have already fired; only reject if not yet resolved
          if (!this.myId) reject(err);
        }
      });
    });
  }

  // ─── Joining ────────────────────────────────────────────────────────────
  async join(code) {
    await this.leave();
    this.role = 'client';
    const peerId = ROOM_PREFIX + (code || '').toUpperCase().trim();
    return new Promise((resolve, reject) => {
      this.peer = new Peer({ debug: 0 });
      let resolved = false;
      const settle = (fn, val) => { if (!resolved) { resolved = true; fn(val); } };

      this.peer.on('open', id => {
        this.myId = id;
        this.roomCode = code.toUpperCase();
        const conn = this.peer.connect(peerId, { reliable: false, serialization: 'json' });
        // If the host doesn't exist, connect emits 'error' instead of 'open'
        const connectTimeout = setTimeout(() => {
          settle(reject, new Error('המארח לא ענה. בדוק את הקוד.'));
        }, 8000);
        conn.on('open', () => {
          clearTimeout(connectTimeout);
          this.connections.set(conn.peer, conn);
          this._wireOutgoing(conn);
          this._sayHello(conn);
          settle(resolve);
        });
        conn.on('error', err => {
          clearTimeout(connectTimeout);
          settle(reject, err);
        });
      });
      this.peer.on('error', err => {
        if (err && err.type === 'peer-unavailable') {
          settle(reject, new Error('חדר עם הקוד הזה לא קיים.'));
        } else {
          settle(reject, err);
        }
      });
    });
  }

  // ─── Connection wiring ──────────────────────────────────────────────────
  _wireIncoming(conn) {
    // Host receiving a new client connection
    conn.on('open', () => {
      this.connections.set(conn.peer, conn);
      this._wireOutgoing(conn);
      this._sayHello(conn);
      this.dispatchEvent(new CustomEvent('peer-join', { detail: { peerId: conn.peer } }));
    });
  }

  _wireOutgoing(conn) {
    this.lastSeen.set(conn.peer, performance.now());
    conn.on('data', data => {
      // Any inbound packet counts as a heartbeat — the connection is alive.
      this.lastSeen.set(conn.peer, performance.now());
      if (data && data.type === 'hello') {
        this.peerProfiles.set(conn.peer, data.profile || {});
        this.dispatchEvent(new CustomEvent('peer-profile', { detail: { peerId: conn.peer, profile: data.profile } }));
        return;
      }
      // ping/pong is internal — don't bubble it up to game code
      if (data && (data.type === 'ping' || data.type === 'pong')) {
        if (data.type === 'ping') {
          try { conn.send({ type: 'pong' }); } catch {}
        }
        return;
      }
      this.dispatchEvent(new CustomEvent('message', { detail: { from: conn.peer, data } }));
    });
    conn.on('close', () => this._cleanupPeer(conn.peer));
    conn.on('error', () => this._cleanupPeer(conn.peer));
    if (!this._heartbeatTimer) this._startHeartbeat();
  }

  _cleanupPeer(peerId) {
    if (!this.connections.has(peerId)) return;
    this.connections.delete(peerId);
    this.peerProfiles.delete(peerId);
    this.lastSeen.delete(peerId);
    this.dispatchEvent(new CustomEvent('peer-leave', { detail: { peerId } }));
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      const now = performance.now();
      // Send a ping to every peer; the response is observed via `data` handler
      for (const [peerId, conn] of this.connections) {
        try { conn.send({ type: 'ping' }); } catch {}
        // Drop peers we haven't heard from in too long
        const last = this.lastSeen.get(peerId) ?? now;
        if (now - last > HEARTBEAT_TIMEOUT_MS) {
          try { conn.close(); } catch {}
          this._cleanupPeer(peerId);
        }
      }
      if (this.connections.size === 0) this._stopHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _sayHello(conn) {
    try { conn.send({ type: 'hello', profile: this.profile }); } catch {}
  }

  // ─── Sending ────────────────────────────────────────────────────────────
  broadcast(msg) {
    for (const conn of this.connections.values()) {
      try { conn.send(msg); } catch {}
    }
  }

  sendTo(peerId, msg) {
    const conn = this.connections.get(peerId);
    if (conn) try { conn.send(msg); } catch {}
  }

  // For clients: send to the host (the only connection they have)
  sendToHost(msg) {
    for (const conn of this.connections.values()) {
      try { conn.send(msg); break; } catch {}
    }
  }

  // ─── Tear-down ──────────────────────────────────────────────────────────
  async leave() {
    this._stopHeartbeat();
    for (const conn of this.connections.values()) {
      try { conn.close(); } catch {}
    }
    this.connections.clear();
    this.peerProfiles.clear();
    this.lastSeen.clear();
    if (this.peer) {
      try { this.peer.destroy(); } catch {}
      this.peer = null;
    }
    this.role = null;
    this.myId = null;
    this.roomCode = null;
  }
}

export const net = new Net();
