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

  socket.on('create_room', ({ roomCode, players }) => {
    const enrichedPlayers = players.map(p => ({
      ...p,
      poison: 0,
      commanderTax: 0,
      commanderDamage: {},
      eliminated: false,
    }));
    rooms[roomCode] = {
      players: enrichedPlayers,
      hostId: socket.id,
      hostPlayerId: players[0].id,
      log: [],
    };
    socket.join(roomCode);
    socket.emit('room_created', { roomCode, players: enrichedPlayers });
    console.log(`Room created: ${roomCode}`);
  });

  socket.on('join_room', ({ roomCode, playerName, playerId, spectator }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('join_error', { message: 'Room not found. Check your code.' });
      return;
    }

    const PLAYER_COLORS = [
      '#39ff14', '#7b2fbe', '#ff4444', '#4488ff',
      '#ff9900', '#ff44cc', '#00cccc', '#ffff00',
      '#ff6644', '#44ff88',
    ];

    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    const existingPlayer = playerId
      ? room.players.find(p => p.id === playerId)
      : null;

    if (existingPlayer) {
      existingPlayer.name = playerName;
      socket.data.playerId = existingPlayer.id;
      socket.emit('joined_room', {
        roomCode,
        players: room.players,
        playerId: existingPlayer.id,
        log: room.log,
      });
      io.to(roomCode).emit('players_updated', { players: room.players });
      console.log(`${playerName} rejoined room ${roomCode}`);
      return;
    }

    if (spectator) {
      socket.emit('joined_room', { roomCode, players: room.players, log: room.log });
      return;
    }

    if (room.players.filter(p => p.name !== 'Spectator').length >= 10) {
      socket.emit('join_error', { message: 'Room is full.' });
      return;
    }

    const newPlayer = {
      id: Date.now(),
      name: playerName,
      life: 40,
      color: PLAYER_COLORS[room.players.length % PLAYER_COLORS.length],
      poison: 0,
      commanderTax: 0,
      commanderDamage: {},
      eliminated: false,
    };

    room.players.push(newPlayer);
    socket.data.playerId = newPlayer.id;

    socket.emit('joined_room', {
      roomCode,
      players: room.players,
      playerId: newPlayer.id,
      log: room.log,
    });
    io.to(roomCode).emit('players_updated', { players: room.players });
    console.log(`${playerName} joined room ${roomCode}`);
  });

  const addLog = (room, roomCode, message) => {
    const entry = {
      id: Date.now(),
      message,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    room.log.unshift(entry);
    if (room.log.length > 100) room.log.pop();
    io.to(roomCode).emit('log_updated', { log: room.log });
  };

  const checkElimination = (room, roomCode, player) => {
    if (player.eliminated) return;

    // Check life
    if (player.life <= 0) {
      player.eliminated = true;
      addLog(room, roomCode, `${player.name} has been eliminated! (life reached 0)`);
      io.to(roomCode).emit('players_updated', { players: room.players });
      return;
    }

    // Check poison
    if (player.poison >= 10) {
      player.eliminated = true;
      addLog(room, roomCode, `${player.name} has been eliminated! (10 poison counters)`);
      io.to(roomCode).emit('players_updated', { players: room.players });
      return;
    }

    // Check commander damage from each source
    for (const [sourceId, damage] of Object.entries(player.commanderDamage)) {
      if (damage >= 21) {
        player.eliminated = true;
        addLog(room, roomCode, `${player.name} has been eliminated! (21 commander damage)`);
        io.to(roomCode).emit('players_updated', { players: room.players });
        return;
      }
    }
  };

  socket.on('update_life', ({ roomCode, playerId, newLife, changedBy }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    const oldLife = player.life;
    player.life = newLife;
    const diff = newLife - oldLife;
    const sign = diff > 0 ? '+' : '';
    addLog(room, roomCode, `${player.name}: ${oldLife} → ${newLife} (${sign}${diff})`);
    checkElimination(room, roomCode, player);
    io.to(roomCode).emit('players_updated', { players: room.players });
  });

  socket.on('update_poison', ({ roomCode, playerId, amount }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    player.poison = Math.max(0, player.poison + amount);
    addLog(room, roomCode, `${player.name}: Poison ${amount > 0 ? '+' : ''}${amount} (total: ${player.poison})`);
    checkElimination(room, roomCode, player);
    io.to(roomCode).emit('players_updated', { players: room.players });
  });

  socket.on('update_commander_tax', ({ roomCode, playerId, amount }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    player.commanderTax = Math.max(0, player.commanderTax + amount);
    addLog(room, roomCode, `${player.name}: Commander Tax ${amount > 0 ? '+' : ''}${amount} (total: ${player.commanderTax})`);
    io.to(roomCode).emit('players_updated', { players: room.players });
  });

  socket.on('update_commander_damage', ({ roomCode, targetId, sourceId, sourceName, amount }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const target = room.players.find(p => p.id === targetId);
    if (!target) return;
    if (!target.commanderDamage) target.commanderDamage = {};
    const current = target.commanderDamage[sourceId] || 0;
    const newDamage = Math.max(0, current + amount);
    target.commanderDamage[sourceId] = newDamage;
    // Also reduce life total
    target.life = Math.max(-99, target.life - amount);
    addLog(room, roomCode, `${target.name} took ${amount} commander damage from ${sourceName} (total: ${newDamage})`);
    checkElimination(room, roomCode, target);
    io.to(roomCode).emit('players_updated', { players: room.players });
  });

  socket.on('revive_player', ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    player.eliminated = false;
    player.life = 40;
    player.poison = 0;
    player.commanderDamage = {};
    addLog(room, roomCode, `${player.name} has been revived!`);
    io.to(roomCode).emit('players_updated', { players: room.players });
  });

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
      poison: 0,
      commanderTax: 0,
      commanderDamage: {},
      eliminated: false,
      manual: true,
    };

    room.players.push(newPlayer);
    addLog(room, roomCode, `${playerName} joined the game`);
    io.to(roomCode).emit('players_updated', { players: room.players });
  });

  socket.on('remove_player', ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (player) addLog(room, roomCode, `${player.name} was removed from the game`);
    room.players = room.players.filter(p => p.id !== playerId);
    io.to(roomCode).emit('players_updated', { players: room.players });
  });

  socket.on('update_name', ({ roomCode, playerId, newName }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    const oldName = player.name;
    player.name = newName;
    addLog(room, roomCode, `${oldName} changed their name to ${newName}`);
    io.to(roomCode).emit('players_updated', { players: room.players });
  });

  socket.on('sync_state', ({ roomCode, players }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.players = players;
    socket.to(roomCode).emit('players_updated', { players });
  });
socket.on('roll_dice', ({ roomCode, playerId, playerName, roll }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (!room.rolls) room.rolls = {};
    room.rolls[playerId] = { playerName, roll };
    addLog(room, roomCode, `${playerName} rolled a ${roll}`);
    io.to(roomCode).emit('dice_rolled', {
      rolls: room.rolls,
      players: room.players,
    });
  });

  socket.on('clear_rolls', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.rolls = {};
    io.to(roomCode).emit('rolls_cleared');
  });

  socket.on('start_game', ({ roomCode, players }) => {
    const room = rooms[roomCode];
    if (!room) return;
    addLog(room, roomCode, 'The game is starting!');
    socket.to(roomCode).emit('game_starting', { players: room.players, roomCode });
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    for (const [code, room] of Object.entries(rooms)) {
      if (room.hostId === socket.id) {
        const roomSockets = io.sockets.adapter.rooms.get(code);
        if (!roomSockets || roomSockets.size === 0) {
          delete rooms[code];
          console.log(`Room ${code} closed — everyone left`);
        } else {
          const newHostSocketId = [...roomSockets][0];
          room.hostId = newHostSocketId;
          io.to(code).emit('host_migrated', {
            message: 'The host has left. A new host has been assigned.',
          });
          console.log(`Room ${code} — new host assigned: ${newHostSocketId}`);
        }
      }
    }
  });
  socket.on('request_log', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    socket.emit('log_updated', { log: room.log });
  });
  socket.on('spin_wheel', ({ roomCode, winnerId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const winner = room.players.find(p => p.id === winnerId);
    if (!winner) return;
    addLog(room, roomCode, `The Wither Wheel chose ${winner.name} to go first!`);
    io.to(roomCode).emit('wheel_result', { winnerId, winnerName: winner.name });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Wither server running on port ${PORT}`);
});