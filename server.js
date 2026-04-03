const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Store active game rooms in memory
const rooms = {};

app.get('/', (req, res) => {
  res.send('Wither Sync Server is running.');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeRooms: Object.keys(rooms).length,
  });
});

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Host creates a new room
  socket.on('create_room', ({ roomCode, players }) => {
    rooms[roomCode] = { players, hostId: socket.id };
    socket.join(roomCode);
    socket.emit('room_created', { roomCode, players });
    console.log(`Room created: ${roomCode}`);
  });

  // Player joins existing room
  socket.on('join_room', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('join_error', { message: 'Room not found. Check your code.' });
      return;
    }
    if (room.players.length >= 10) {
      socket.emit('join_error', { message: 'Room is full.' });
      return;
    }

    const PLAYER_COLORS = [
      '#39ff14', '#7b2fbe', '#ff4444', '#4488ff',
      '#ff9900', '#ff44cc', '#00cccc', '#ffff00',
      '#ff6644', '#44ff88',
    ];

    const newPlayer = {
      id: Date.now(),
      name: playerName,
      life: 40,
      color: PLAYER_COLORS[room.players.length % PLAYER_COLORS.length],
    };

    room.players.push(newPlayer);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = newPlayer.id;

    // Send current state to joining player
    socket.emit('joined_room', { roomCode, players: room.players });

    // Tell everyone else a new player joined
    io.to(roomCode).emit('players_updated', { players: room.players });
    console.log(`${playerName} joined room ${roomCode}`);
  });

  // Life total changed
  socket.on('update_life', ({ roomCode, playerId, newLife }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.players = room.players.map(p =>
      p.id === playerId ? { ...p, life: newLife } : p
    );
    io.to(roomCode).emit('players_updated', { players: room.players });
  });

  // Player added manually by host
  socket.on('add_player', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.players.length >= 10) return;

    const PLAYER_COLORS = [
      '#39ff14', '#7b2fbe', '#ff4444', '#4488ff',
      '#ff9900', '#ff44cc', '#00cccc', '#ffff00',
      '#ff6644', '#44ff88',
    ];

    const newPlayer = {
      id: Date.now(),
      name: playerName,
      life: 40,
      color: PLAYER_COLORS[room.players.length % PLAYER_COLORS.length],
    };

    room.players.push(newPlayer);
    io.to(roomCode).emit('players_updated', { players: room.players });
  });

  // Player removed
  socket.on('remove_player', ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== playerId);
    io.to(roomCode).emit('players_updated', { players: room.players });
  });

  // Full game state sync
  socket.on('sync_state', ({ roomCode, players }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.players = players;
    socket.to(roomCode).emit('players_updated', { players });
  });

  // Player disconnects
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    // Clean up empty rooms
    for (const [code, room] of Object.entries(rooms)) {
      if (room.hostId === socket.id) {
        delete rooms[code];
        io.to(code).emit('host_left');
        console.log(`Room ${code} closed — host left`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Wither server running on port ${PORT}`);
});