/// <reference types="bun-types" />
import dgram from "node:dgram";
import net from "node:net";
import { readFileSync } from "node:fs";

const port = Number(process.env.PORT || 10000);
const hldsPort = Number(process.env.HLDS_PORT || 27015);
const expectedMap = process.env.HLDS_MAP || "de_dust2";
const expectedBots = Number(process.env.HLDS_BOT_QUOTA || 9);
const expectedMaxPlayers = Number(process.env.HLDS_MAXPLAYERS || 16);
const allowedOrigin = process.env.BRIDGE_ALLOWED_ORIGINS?.split(",")[0]?.trim();
const password = process.env.HLDS_RCON_PASSWORD;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rcon(command: string): Promise<string> {
  assert(password, "HLDS_RCON_PASSWORD is required");
  const socket = dgram.createSocket("udp4");
  try {
    const receive = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`RCON timeout for ${command}`)),
          5000,
        );
        socket.once("message", (message) => {
          clearTimeout(timer);
          resolve(message.toString("utf8").replace(/\0+$/, ""));
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

    socket.send(
      Buffer.concat([
        Buffer.from([0xff, 0xff, 0xff, 0xff]),
        Buffer.from("challenge rcon\n"),
      ]),
      hldsPort,
      "127.0.0.1",
    );
    const challengeResponse = await receive();
    const challenge = challengeResponse.trim().split(/\s+/).at(-1);
    assert(
      challenge && /^\d+$/.test(challenge),
      `Invalid RCON challenge: ${challengeResponse}`,
    );

    socket.send(
      Buffer.concat([
        Buffer.from([0xff, 0xff, 0xff, 0xff]),
        Buffer.from(`rcon ${challenge} ${password} ${command}\n`),
      ]),
      hldsPort,
      "127.0.0.1",
    );
    return await receive();
  } finally {
    socket.close();
  }
}

async function websocketStatus(origin: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("WebSocket handshake timeout"));
    }, 5000);

    socket.on("connect", () => {
      const headers = [
        "GET / HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ];
      if (origin) headers.push(`Origin: ${origin}`);
      socket.write(`${headers.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      const end = response.indexOf("\r\n\r\n");
      if (end < 0) return;
      clearTimeout(timer);
      socket.destroy();
      const match = response.match(/^HTTP\/\d(?:\.\d)? (\d{3})/);
      if (!match)
        reject(
          new Error(`Invalid WebSocket response: ${response.slice(0, 200)}`),
        );
      else resolve(Number(match[1]));
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main(): Promise<void> {
  assert(allowedOrigin, "BRIDGE_ALLOWED_ORIGINS is required");
  assert(password, "HLDS_RCON_PASSWORD is required");

  const originless = await fetch(`http://127.0.0.1:${port}/health`);
  assert(
    originless.status === 200,
    `Originless health returned ${originless.status}`,
  );
  const healthText = await originless.text();
  assert(
    !healthText.includes(password),
    "Health response disclosed the RCON password",
  );
  const health = JSON.parse(healthText) as {
    hlds: boolean;
    map: string;
    bots: number;
    maxPlayers: number;
  };
  assert(health.hlds === true, "Health does not report a live HLDS");
  assert(
    health.map === expectedMap,
    `Health map is ${health.map}, expected ${expectedMap}`,
  );
  assert(
    health.bots === expectedBots,
    `Health bots is ${health.bots}, expected ${expectedBots}`,
  );
  assert(
    health.maxPlayers === expectedMaxPlayers,
    `Health maxPlayers is ${health.maxPlayers}, expected ${expectedMaxPlayers}`,
  );

  const allowed = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Origin: allowedOrigin },
  });
  assert(allowed.status === 200, `Allowed origin returned ${allowed.status}`);
  assert(
    allowed.headers.get("access-control-allow-origin") === allowedOrigin,
    "Allowed origin was not echoed in the CORS header",
  );

  const denied = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Origin: "https://denied.example" },
  });
  assert(denied.status === 403, `Denied origin returned ${denied.status}`);
  assert(
    (await fetch(`http://127.0.0.1:${port}/logs`)).status === 404,
    "/logs must not be public",
  );

  assert(
    (await websocketStatus(allowedOrigin)) === 101,
    "Allowed WebSocket origin was not accepted",
  );
  assert(
    (await websocketStatus("https://denied.example")) === 403,
    "Denied WebSocket origin was accepted",
  );
  assert(
    (await websocketStatus(null)) === 403,
    "Originless WebSocket upgrade was accepted",
  );

  const status = await rcon("status");
  assert(
    status.includes(expectedMap),
    `RCON status does not contain map ${expectedMap}: ${status}`,
  );
  assert(
    new RegExp(`maxplayers\\s*[:=]\\s*${expectedMaxPlayers}\\b`, "i").test(
      status,
    ),
    `RCON status does not contain maxplayers ${expectedMaxPlayers}: ${status}`,
  );

  const game = await rcon("meta game");
  assert(
    /regamedll/i.test(game),
    `RCON meta game does not identify ReGameDLL: ${game}`,
  );

  const plugins = await rcon("meta list");
  assert(
    /yapb/i.test(plugins),
    `RCON meta list does not contain YaPB: ${plugins}`,
  );
  assert(
    /1 plugins?, 1 running/i.test(plugins),
    `Unexpected MetaMod plugin list: ${plugins}`,
  );

  const quota = await rcon("yb_quota");
  assert(
    new RegExp(`\\b${expectedBots}\\b`).test(quota),
    `RCON yb_quota is not ${expectedBots}: ${quota}`,
  );

  const serverCfg = readFileSync("/app/cstrike/server.cfg", "utf8");
  const mapCycle = readFileSync("/app/cstrike/mapcycle.txt", "utf8").trim();
  const execCfg = readFileSync("/app/cstrike/addons/metamod/exec.cfg", "utf8");
  const yapbCfg = readFileSync(
    "/app/cstrike/addons/yapb/conf/yapb.cfg",
    "utf8",
  );
  const pluginsIni = readFileSync(
    "/app/cstrike/addons/metamod/plugins.ini",
    "utf8",
  ).trim();
  const liblist = readFileSync("/app/cstrike/liblist.gam", "utf8");
  assert(
    serverCfg.includes(`maxplayers "${expectedMaxPlayers}"`),
    "server.cfg has the wrong maxplayers",
  );
  assert(
    serverCfg.includes(`rcon_password "${password}"`),
    "server.cfg is missing the RCON password",
  );
  assert(
    mapCycle === expectedMap,
    `mapcycle.txt is ${mapCycle}, expected ${expectedMap}`,
  );
  assert(
    execCfg.includes(`yb_quota ${expectedBots}`),
    "MetaMod exec.cfg has the wrong quota",
  );
  assert(
    new RegExp(`^yb_quota\\s+\"?${expectedBots}\"?$`, "m").test(yapbCfg),
    "YaPB main config has the wrong quota",
  );
  assert(
    pluginsIni === "linux addons/yapb/bin/yapb.so",
    `Unexpected plugins.ini: ${pluginsIni}`,
  );
  assert(
    /gamedll_linux\s+"addons\/metamod\/dlls\/metamod\.so"/.test(liblist),
    "liblist.gam does not load MetaMod-P",
  );

  console.log("CS16_RENDER_SMOKE=PASS");
}

void main().catch((error) => {
  console.error("CS16_RENDER_SMOKE=FAIL", error);
  process.exit(1);
});
