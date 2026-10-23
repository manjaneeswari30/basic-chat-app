
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve website files from the repository root
app.use(express.static(__dirname));

// Home page route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// In-memory stores for prototype
const users = {};
const userByName = {};
const rooms = { general: [] };
const privateHistory = {};

function privateKey(a, b) {
  return [a, b].sort().join("|");
}

function getOnlineList() {
  return Object.values(users).map((u) => ({
    username: u.username,
    avatar: u.avatar,
    room: u.currentRoom,
  }));
}

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("join", (profile = {}, cb) => {
    const username =
      profile.username || "User" + socket.id.slice(0, 4);
    const avatar = profile.avatar || null;

    users[socket.id] = {
      username,
      avatar,
      currentRoom: "general",
      lastSeen: null,
    };

    userByName[username] = socket.id;
    socket.join("general");

    io.emit("presence", getOnlineList());

    if (typeof cb === "function") {
      cb({
        ok: true,
        history: rooms.general.slice(-200),
      });
    }

    io.to("general").emit("systemMessage", {
      text: `${username} joined general`,
    });
  });

  socket.on("joinRoom", (room, cb) => {
    const user = users[socket.id];
    if (!user || typeof room !== "string" || !room.trim()) return;

    socket.leave(user.currentRoom);
    socket.join(room);
    user.currentRoom = room;

    rooms[room] = rooms[room] || [];

    if (typeof cb === "function") {
      cb({
        ok: true,
        history: rooms[room].slice(-200),
      });
    }

    io.to(room).emit("systemMessage", {
      text: `${user.username} joined ${room}`,
    });

    io.emit("presence", getOnlineList());
  });

  socket.on("roomMessage", (payload = {}, ack) => {
    const user = users[socket.id];
    if (!user || typeof payload.text !== "string") return;

    const room = user.currentRoom || "general";

    const message = {
      id: Date.now() + "_" + Math.random().toString(36).slice(2),
      user: user.username,
      avatar: user.avatar,
      text: payload.text,
      ts: Date.now(),
      room,
    };

    rooms[room] = rooms[room] || [];
    rooms[room].push(message);

    io.to(room).emit("message", message);

    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("privateMessage", (payload = {}, ack) => {
    const sender = users[socket.id];

    if (!sender || typeof payload.to !== "string" ||
        typeof payload.text !== "string") return;

    const key = privateKey(sender.username, payload.to);

    const message = {
      id: Date.now() + "_" + Math.random().toString(36).slice(2),
      from: sender.username,
      to: payload.to,
      text: payload.text,
      ts: Date.now(),
      seen: false,
    };

    privateHistory[key] = privateHistory[key] || [];
    privateHistory[key].push(message);

    const recipientSocket = userByName[payload.to];

    if (recipientSocket && io.sockets.sockets.has(recipientSocket)) {
      io.to(recipientSocket).emit("privateMessage", message);
    }

    socket.emit("privateMessage", message);

    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("typing", (data = {}) => {
    const user = users[socket.id];
    if (!user) return;

    if (data.type === "room") {
      socket.to(user.currentRoom || "general").emit("typing", {
        user: user.username,
      });
    } else if (data.type === "private" && data.to) {
      const recipientSocket = userByName[data.to];

      if (recipientSocket) {
        io.to(recipientSocket).emit("typing", {
          user: user.username,
          private: true,
        });
      }
    }
  });

  socket.on("markSeen", (data = {}) => {
    const user = users[socket.id];
    if (!user || !data.convWith || !data.messageId) return;

    const key = privateKey(user.username, data.convWith);
    const messages = privateHistory[key] || [];
    const message = messages.find((item) => item.id === data.messageId);

    if (message) {
      message.seen = true;

      const senderSocket = userByName[message.from];

      if (senderSocket) {
        io.to(senderSocket).emit("messageSeen", {
          messageId: message.id,
          by: user.username,
        });
      }
    }
  });

  socket.on("disconnect", () => {
    const user = users[socket.id];

    if (user) {
      user.lastSeen = Date.now();

      if (userByName[user.username] === socket.id) {
        delete userByName[user.username];
      }

      delete users[socket.id];

      io.emit("presence", getOnlineList());
      io.emit("systemMessage", {
        text: `${user.username} left`,
      });

      console.log("Disconnected:", socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server listening on", PORT);
});
