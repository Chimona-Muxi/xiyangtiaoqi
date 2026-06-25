import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAction, createInitialState } from "./public/engine.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 5186);
const host = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const rooms = new Map();
const streams = new Map();

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function bodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function cleanName(name, fallback) {
  const text = String(name || "").trim().slice(0, 14);
  return text || fallback;
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function createRoom(hostName, clientId) {
  const code = randomCode();
  const room = {
    code,
    seats: [
      { clientId: "", name: "", connected: false },
      { clientId: "", name: "", connected: false }
    ],
    started: false,
    state: createInitialState({ mode: "online", names: ["玩家 1", "玩家 2"] }),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  rooms.set(code, room);
  addSeat(room, clientId, hostName);
  return room;
}

function addSeat(room, clientId, name) {
  const existing = room.seats.findIndex((seat) => seat.clientId === clientId);
  if (existing >= 0) {
    const displayName = cleanName(name, room.seats[existing].name);
    room.seats[existing].name = displayName;
    room.seats[existing].connected = true;
    room.state.players[existing].name = displayName;
    room.updatedAt = Date.now();
    return existing;
  }

  const seatIndex = room.seats.findIndex((seat) => !seat.clientId);
  if (seatIndex < 0) return -1;

  const displayName = cleanName(name, `玩家 ${seatIndex + 1}`);
  room.seats[seatIndex] = { clientId, name: displayName, connected: true };
  room.state.players[seatIndex].name = displayName;
  room.started = room.seats.every((seat) => Boolean(seat.clientId));
  room.updatedAt = Date.now();
  return seatIndex;
}

function setSeatConnected(room, clientId, connected) {
  const seat = room.seats.find((item) => item.clientId === clientId);
  if (!seat) return;
  seat.connected = connected;
  room.updatedAt = Date.now();
}

function publicRoom(room, clientId = "") {
  return {
    code: room.code,
    started: room.started,
    seats: room.seats.map((seat, index) => ({
      index,
      occupied: Boolean(seat.clientId),
      connected: Boolean(seat.connected),
      name: seat.name,
      color: room.state.players[index].color
    })),
    mySeat: clientId ? room.seats.findIndex((seat) => seat.clientId === clientId) : -1,
    state: room.state
  };
}

function streamKey(code, clientId) {
  return `${code}:${clientId}`;
}

function broadcast(room) {
  for (const [key, res] of streams) {
    if (key.startsWith(`${room.code}:`)) {
      const clientId = key.slice(room.code.length + 1);
      res.write(`data: ${JSON.stringify(publicRoom(room, clientId))}\n\n`);
    }
  }
}

function handleEvents(req, res, room, clientId) {
  if (!clientId) {
    json(res, 400, { error: "缺少客户端标识" });
    return;
  }
  setSeatConnected(room, clientId, true);
  const key = streamKey(room.code, clientId);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive"
  });
  res.write(`data: ${JSON.stringify(publicRoom(room, clientId))}\n\n`);
  streams.set(key, res);
  req.on("close", () => {
    streams.delete(key);
    setSeatConnected(room, clientId, false);
    broadcast(room);
  });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method || "GET";

  if (method === "POST" && url.pathname === "/api/rooms") {
    const body = await bodyJson(req);
    const clientId = String(body.clientId || "");
    if (!clientId) return json(res, 400, { error: "缺少客户端标识" });
    const room = createRoom(body.name, clientId);
    return json(res, 200, publicRoom(room, clientId));
  }

  if (parts[0] === "api" && parts[1] === "rooms" && parts[2]) {
    const code = parts[2].toUpperCase();
    const room = rooms.get(code);
    if (!room) return json(res, 404, { error: "房间不存在" });

    if (method === "GET" && parts[3] === "events") {
      return handleEvents(req, res, room, url.searchParams.get("clientId") || "");
    }

    if (method === "GET" && parts.length === 3) {
      const clientId = url.searchParams.get("clientId") || "";
      if (clientId) setSeatConnected(room, clientId, true);
      return json(res, 200, publicRoom(room, clientId));
    }

    if (method === "POST" && parts[3] === "join") {
      const body = await bodyJson(req);
      const clientId = String(body.clientId || "");
      if (!clientId) return json(res, 400, { error: "缺少客户端标识" });
      const seat = addSeat(room, clientId, body.name);
      if (seat < 0) return json(res, 409, { error: "房间已满" });
      broadcast(room);
      return json(res, 200, publicRoom(room, clientId));
    }

    if (method === "POST" && parts[3] === "action") {
      const body = await bodyJson(req);
      const clientId = String(body.clientId || "");
      const seat = room.seats.findIndex((item) => item.clientId === clientId);
      if (!room.started) return json(res, 409, { error: "等待玩家入座" });
      if (seat < 0) return json(res, 403, { error: "你不在这个房间里" });
      if (room.state.current !== seat) return json(res, 409, { error: "还没轮到你" });

      const result = applyAction(room.state, body.action);
      if (!result.ok) return json(res, 400, { error: result.reason || "这步不合法" });
      room.state = result.state;
      room.updatedAt = Date.now();
      broadcast(room);
      return json(res, 200, publicRoom(room, clientId));
    }
  }

  return json(res, 404, { error: "未知接口" });
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const target = normalize(join(publicDir, safePath));
  if (!target.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, {
      "Content-Type": mime[extname(target)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  return serveStatic(res, url.pathname);
});

server.listen(port, host, () => {
  console.log("西洋跳棋已启动：");
  console.log(`本机访问：http://localhost:${port}`);
  if (host === "0.0.0.0" || host === "::") {
    console.log(`局域网访问：请打开本机局域网 IP + :${port}`);
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`端口 ${port} 已被占用，请换一个 PORT。`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
