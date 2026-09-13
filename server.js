const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));

const rooms = new Map();

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = "";

    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));

  return code;
}

function publicRoom(room) {
  return {
    code: room.code,
    mode: room.mode,
    duration: room.duration,
    map: room.map,
    owner: room.owner,
    started: room.started,

    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      commander: p.commander
    }))
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
}

function assignTeam(room) {
  if (room.mode === "ffa") {
    return "FFA";
  }

  const black = [...room.players.values()]
    .filter(p => p.team === "BLACK").length;

  const white = [...room.players.values()]
    .filter(p => p.team === "WHITE").length;

  return black <= white ? "BLACK" : "WHITE";
}

io.on("connection", socket => {

  console.log("Player connected:", socket.id);

  // CREATE ROOM
  socket.on("room:create", (data, ack) => {

    const name = String(data?.name || "Pilot").slice(0, 16);

    const mode =
      data?.mode === "ffa"
        ? "ffa"
        : "squadron";

    const duration =
      [2, 4, 6, 10].includes(Number(data?.duration))
        ? Number(data.duration)
        : 4;

    const map =
      Math.min(
        10,
        Math.max(1, Number(data?.map) || 1)
      );

    const code = makeCode();

    const room = {
      code,
      mode,
      duration,
      map,
      owner: socket.id,
      started: false,
      players: new Map()
    };

    room.players.set(socket.id, {
      id: socket.id,
      name,
      team: assignTeam(room),
      commander: true,

      x: 0,
      y: 0,
      z: 0,

      rx: 0,
      ry: 0,
      rz: 0,

      speed: 180
    });

    rooms.set(code, room);

    socket.join(code);

    socket.data.room = code;

    socket.emit(
      "room:created",
      publicRoom(room)
    );

    broadcastRoom(room);

    if (ack) {
      ack({
        ok: true,
        code
      });
    }

    console.log("Room created:", code);
  });


  // JOIN ROOM
  socket.on("room:join", (data, ack) => {

    const code =
      String(data?.code || "")
        .trim()
        .toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      return ack?.({
        ok: false,
        error: "اتاق پیدا نشد"
      });
    }

    if (room.started) {
      return ack?.({
        ok: false,
        error: "بازی شروع شده"
      });
    }

    if (room.players.size >= 20) {
      return ack?.({
        ok: false,
        error: "اتاق پر است"
      });
    }

    const name =
      String(data?.name || "Pilot")
        .slice(0, 16);

    const player = {
      id: socket.id,
      name,

      team: assignTeam(room),
      commander: false,

      x: 0,
      y: 0,
      z: 0,

      rx: 0,
      ry: 0,
      rz: 0,

      speed: 180
    };

    room.players.set(socket.id, player);

    socket.join(code);

    socket.data.room = code;

    ack?.({
      ok: true,
      code
    });

    broadcastRoom(room);

    console.log(
      "Player joined:",
      name,
      code
    );
  });


  // START GAME
  socket.on("room:start", (_, ack) => {

    const room = rooms.get(socket.data.room);

    if (!room) {
      return;
    }

    if (room.owner !== socket.id) {
      return ack?.({
        ok: false,
        error: "فقط سازنده اتاق می‌تواند شروع کند"
      });
    }

    if (room.players.size < 1) {
      return ack?.({
        ok: false,
        error: "بازیکنی در اتاق نیست"
      });
    }

    room.started = true;

    for (const p of room.players.values()) {

      if (p.team === "WHITE") {
        p.x = 500;
      } else {
        p.x = -500;
      }

      p.y = 0;
      p.z = 0;

      p.rx = 0;
      p.ry = 0;
      p.rz = 0;
    }

    io.to(room.code).emit(
      "game:start",
      publicRoom(room)
    );

    ack?.({
      ok: true
    });

    console.log(
      "Game started:",
      room.code
    );
  });


  // PLAYER MOVEMENT
  socket.on("player:state", state => {

    const room = rooms.get(
      socket.data.room
    );

    if (!room || !room.started) {
      return;
    }

    const player =
      room.players.get(socket.id);

    if (!player) {
      return;
    }

    const keys = [
      "x",
      "y",
      "z",
      "rx",
      "ry",
      "rz",
      "speed"
    ];

    for (const key of keys) {

      if (
        Number.isFinite(
          Number(state?.[key])
        )
      ) {
        player[key] =
          Number(state[key]);
      }
    }

    socket.to(room.code).emit(
      "player:state",
      {
        id: socket.id,

        x: player.x,
        y: player.y,
        z: player.z,

        rx: player.rx,
        ry: player.ry,
        rz: player.rz,

        speed: player.speed
      }
    );
  });


  // RESTART
  socket.on("game:restart", () => {

    const room =
      rooms.get(socket.data.room);

    if (!room) {
      return;
    }

    if (room.owner !== socket.id) {
      return;
    }

    room.started = false;

    broadcastRoom(room);
  });


  // DISCONNECT
  socket.on("disconnect", () => {

    console.log(
      "Player disconnected:",
      socket.id
    );

    const code =
      socket.data.room;

    const room = rooms.get(code);

    if (!room) {
      return;
    }

    room.players.delete(socket.id);

    // If room owner leaves,
    // transfer ownership.
    if (room.owner === socket.id) {

      const next =
        room.players.values().next().value;

      if (next) {

        room.owner = next.id;

      } else {

        rooms.delete(code);

        return;
      }
    }

    if (room.players.size > 0) {

      const firstByTeam = {};

      for (const p of room.players.values()) {

        if (!firstByTeam[p.team]) {
          firstByTeam[p.team] = p.id;
        }
      }

      for (const p of room.players.values()) {

        p.commander =
          p.id === room.owner ||
          p.id === firstByTeam[p.team];
      }

      broadcastRoom(room);
    }
  });

});


app.get("/health", (req, res) => {

  res.json({
    ok: true,
    rooms: rooms.size
  });

});


server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Fighter server running on port ${PORT}`
    );

  }
);
