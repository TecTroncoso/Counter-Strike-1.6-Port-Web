/**
 * CS 1.6 Web Port — network transport.
 *
 * The Xash3D WASM build exposes a virtual UDP stack (Net class from the
 * xash3d-fwgs npm package). The engine calls `sendto` with fake IPs
 * (101.101.x.y produced by its getaddrinfo mapping of "<name>.<hostID>").
 *
 * This sender tunnels every non-loopback datagram through a single binary
 * WebSocket to the sandbox bridge (mini-services/cs16-server), which owns a
 * real UDP socket against the dedicated server. Replies are pushed back into
 * the engine's incoming queue stamped with the fake server address.
 */

const SERVER_HOST_ID = 3000; // webxash3d.3000 → ip 101.101.184.11

/** Packet shape used by the engine's virtual UDP stack (Int8Array data). */
export interface Packet {
  data: Int8Array;
  ip: [number, number, number, number];
  port: number;
}

interface NetLike {
  incoming: {
    push: (packet: Packet) => void;
  };
}

export function fakeServerIp(hostId = SERVER_HOST_ID): [number, number, number, number] {
  return [101, 101, hostId & 0xff, (hostId >> 8) & 0xff];
}

export function isLoopbackIp(ip: [number, number, number, number]): boolean {
  return ip[0] === 127 || ip[0] === 0;
}

export class WsUdpSender {
  private ws: WebSocket | null = null;
  private pending: Uint8Array[] = [];
  private closed = false;
  serverIp: [number, number, number, number] = fakeServerIp();
  serverPort = 27015;

  constructor(
    private net: NetLike,
    private wsUrl: string,
    private log: (msg: string) => void = () => {},
  ) {}

  sendto = (packet: Packet): void => {
    if (this.closed) return;
    const data = packet.data instanceof Int8Array ? new Uint8Array(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength) : (packet.data as unknown as Uint8Array);
    const ip = packet.ip;
    const port = packet.port;
    if (isLoopbackIp(ip)) {
      // Engine loopback (listen server) — bounce straight back.
      this.net.incoming.push({ data: data as unknown as Int8Array, ip, port });
      return;
    }
    // Everything else (fake server addresses, LAN broadcasts) → tunnel.
    this.serverIp = ip;
    this.serverPort = port;
    this.tunnel(data);
  };

  private tunnel(data: Uint8Array) {
    const ws = this.ensureWs();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    } else {
      if (this.pending.length > 1024) this.pending.shift();
      this.pending.push(data);
    }
  }

  private ensureWs(): WebSocket {
    if (this.ws) return this.ws;
    this.log(`abriendo túnel WebSocket: ${this.wsUrl}`);
    const ws = new WebSocket(this.wsUrl);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.log("túnel WebSocket abierto");
      for (const p of this.pending.splice(0)) ws.send(p);
    };
    ws.onmessage = (ev) => {
      const data = ev.data;
      let buf: Uint8Array | null = null;
      if (data instanceof ArrayBuffer) buf = new Uint8Array(data);
      else if (typeof Blob !== "undefined" && data instanceof Blob) buf = new Uint8Array(new ArrayBuffer(0));
      else if (data instanceof Uint8Array) buf = data;
      if (!buf || buf.length === 0) return;
      this.net.incoming.push({ data: buf as unknown as Int8Array, ip: this.serverIp, port: this.serverPort });
    };
    ws.onerror = () => this.log("error en el túnel WebSocket");
    ws.onclose = () => {
      this.log("túnel WebSocket cerrado");
      if (!this.closed) this.ws = null;
    };
    this.ws = ws;
    return ws;
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}
