const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const rooms = {};
let logCounter = 0;

const addLog = (room, roomCode, message) => {
  const entry = {
    id: `${Date.now()}_${++logCounter}`,
    message,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
  room.log.unshift(entry);
  if (room.log.length > 100) room.log.pop();
  io.to(roomCode).emit('log_updated', { log: room.log });
};

const checkElimination = (room, roomCode, player) => {
  if (player.eliminated) return;
  if (player.life <= 0) {
    player.eliminated = true;
    addLog(room, roomCode, `${player.name} has been eliminated! (life reached 0)`);
    io.to(roomCode).emit('players_updated', { players: room.players });
    return;
  }
  if (player.poison >= 10) {
    player.eliminated = true;
    addLog(room, roomCode, `${player.name} has been eliminated! (10 poison counters)`);
    io.to(roomCode).emit('players_updated', { players: room.players });
    return;
  }
  for (const [sourceId, damage] of Object.entries(player.commanderDamage || {})) {
    if (damage >= 21) {
      player.eliminated = true;
      addLog(room, roomCode, `${player.name} has been eliminated! (21 commander damage)`);
      io.to(roomCode).emit('players_updated', { players: room.players });
      return;
    }
  }
};

const beats = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

const getMatchWinner = (p1, p2) => {
  if (p1.pick === p2.pick) return null;
  if (beats[p1.pick] === p2.pick) return p1.player;
  return p2.player;
};

const shuffleArray = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const buildBracket = (players) => {
  const shuffled = shuffleArray(players);
  const matches = [];
  for (let i = 0; i < shuffled.length; i += 2) {
    if (i + 1 < shuffled.length) {
      matches.push({
        id: `match_${Date.now()}_${i}`,
        player1: shuffled[i],
        player2: shuffled[i + 1],
        bye: false,
      });
    } else {
      matches.push({
        id: `match_${Date.now()}_${i}`,
        player1: shuffled[i],
        player2: null,
        bye: true,
      });
    }
  }
  return matches;
};

const triggerCountdownAndReveal = (roomCode, match, p1picked, p2picked) => {
  const room = rooms[roomCode];
  if (!room) return;

  io.to(roomCode).emit('rps_countdown', { seconds: 3 });
  setTimeout(() => io.to(roomCode).emit('rps_countdown', { seconds: 2 }), 1000);
  setTimeout(() => io.to(roomCode).emit('rps_countdown', { seconds: 1 }), 2000);

  setTimeout(() => {
    if (!rooms[roomCode]) return;
    const winner = getMatchWinner(
      { player: match.player1, pick: p1picked.pick },
      { player: match.player2, pick: p2picked.pick }
    );

    addLog(room, roomCode,
      `RPS: ${match.player1.name} threw ${p1picked.pick} vs ${match.player2.name} threw ${p2picked.pick} — ${winner ? winner.name + ' wins!' : 'Tie!'}`
    );

    io.to(roomCode).emit('rps_reveal', {
      player1: match.player1,
      player2: match.player2,
      pick1: p1picked.pick,
      pick2: p2picked.pick,
      winner,
      isTie: !winner,
    });

    if (winner) {
      room.rps.roundWinners.push(winner);
      room.rps.matchTieCount = 0;
      room.rps.currentMatchIndex++;
      setTimeout(() => runNextMatch(roomCode), 5000);
    } else {
      room.rps.matchTieCount++;
      room.rps.picks = {};
      setTimeout(() => {
        if (!rooms[roomCode]) return;
        io.to(roomCode).emit('rps_state', {
          bracket: room.rps.bracket,
          currentMatchIndex: room.rps.currentMatchIndex,
          phase: 'picking',
          match,
          roundWinners: room.rps.roundWinners,
          isTie: true,
        });
        // Re-auto-pick for manual players on rematch
        const CHOICES = ['rock', 'paper', 'scissors'];
        [match.player1, match.player2].forEach(player => {
          if (player && player.manual) {
            const autoPick = CHOICES[Math.floor(Math.random() * 3)];
            setTimeout(() => {
              if (!rooms[roomCode]?.rps) return;
              room.rps.picks[player.id] = { playerId: player.id, pick: autoPick };
              io.to(roomCode).emit('rps_pick_received', {
                playerId: player.id,
                playerName: player.name,
              });
              const p1 = room.rps.picks[match.player1.id];
              const p2 = room.rps.picks[match.player2.id];
              if (p1 && p2) triggerCountdownAndReveal(roomCode, match, p1, p2);
            }, 800 + Math.random() * 800);
          }
        });
      }, 5000);
    }
  }, 3000);
};

const runNextMatch = (roomCode) => {
  const room = rooms[roomCode];
  if (!room || !room.rps) return;

  const { bracket, currentMatchIndex } = room.rps;

  if (currentMatchIndex >= bracket.length) {
    const winners = room.rps.roundWinners;
    if (winners.length === 1) {
      addLog(room, roomCode, `${winners[0].name} won Rock Paper Scissors!`);
      io.to(roomCode).emit('rps_champion', { champion: winners[0] });
      return;
    }
    const nextBracket = buildBracket(winners);
    room.rps.bracket = nextBracket;
    room.rps.currentMatchIndex = 0;
    room.rps.roundWinners = [];
    room.rps.picks = {};
    io.to(roomCode).emit('rps_state', {
      bracket: nextBracket,
      currentMatchIndex: 0,
      phase: 'bracket',
      roundWinners: [],
    });
    setTimeout(() => runNextMatch(roomCode), 2000);
    return;
  }

  const match = bracket[currentMatchIndex];

  if (match.bye) {
    room.rps.roundWinners.push(match.player1);
    addLog(room, roomCode, `${match.player1.name} gets a bye and advances!`);
    io.to(roomCode).emit('rps_state', {
      bracket,
      currentMatchIndex,
      phase: 'bye',
      byePlayer: match.player1,
      roundWinners: room.rps.roundWinners,
    });
    room.rps.currentMatchIndex++;
    setTimeout(() => runNextMatch(roomCode), 2500);
    return;
  }

  // Start the match
  room.rps.picks = {};
  room.rps.matchTieCount = 0;
  io.to(roomCode).emit('rps_state', {
    bracket,
    currentMatchIndex,
    phase: 'picking',
    match,
    roundWinners: room.rps.roundWinners,
  });
  addLog(room, roomCode, `RPS Match: ${match.player1.name} vs ${match.player2.name}`);

  // Auto pick for manual players
  const CHOICES = ['rock', 'paper', 'scissors'];
  [match.player1, match.player2].forEach(player => {
    if (player && player.manual) {
      const autoPick = CHOICES[Math.floor(Math.random() * 3)];
      setTimeout(() => {
        if (!rooms[roomCode]?.rps) return;
        room.rps.picks[player.id] = { playerId: player.id, pick: autoPick };
        io.to(roomCode).emit('rps_pick_received', {
          playerId: player.id,
          playerName: player.name,
        });
        const p1picked = room.rps.picks[match.player1.id];
        const p2picked = room.rps.picks[match.player2.id];
        if (p1picked && p2picked) {
          triggerCountdownAndReveal(roomCode, match, p1picked, p2picked);
        }
      }, 800 + Math.random() * 800);
    }
  });
};

app.get('/', (req, res) => res.send('Wither Sync Server is running.'));
app.get('/health', (req, res) => res.json({ status: 'ok', activeRooms: Object.keys(rooms).length }));

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('create_room', ({ roomCode, players }) => {
    const enriched = players.map(p => ({
      ...p,
      poison: 0,
      commanderTax: 0,
      commanderDamage: {},
      eliminated: false,
    }));
    rooms[roomCode] = {
      players: enriched,
      hostId: socket.id,
      hostPlayerId: players[0].id,
      log: [],
    };
    socket.join(roomCode);
    socket.emit('room_created', { roomCode, players: enriched });
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
  });

  socket.on('update_life', ({ roomCode, playerId, newLife }) => {
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

  socket.on('request_log', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    socket.emit('log_updated', { log: room.log });
  });

  socket.on('navigate_wheel', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    socket.to(roomCode).emit('go_to_wheel');
  });

  socket.on('spin_wheel', ({ roomCode, rotation, winnerId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const winner = room.players.find(p => p.id === winnerId);
    if (!winner) return;
    addLog(room, roomCode, `The Wither Wheel chose ${winner.name} to go first!`);
    io.to(roomCode).emit('wheel_result', { winnerId, winnerName: winner.name, rotation });
  });

  socket.on('navigate_rps', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    socket.to(roomCode).emit('go_to_rps');
  });

  socket.on('rps_start_tournament', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const eligible = room.players.filter(p => p.name !== 'Spectator');
    const bracket = buildBracket(eligible);
    room.rps = {
      bracket,
      currentMatchIndex: 0,
      roundWinners: [],
      picks: {},
      matchTieCount: 0,
    };
    addLog(room, roomCode, 'Rock Paper Scissors tournament started!');
    io.to(roomCode).emit('rps_state', {
      bracket,
      currentMatchIndex: 0,
      phase: 'bracket',
      roundWinners: [],
    });
    setTimeout(() => runNextMatch(roomCode), 2000);
  });

  socket.on('rps_pick', ({ roomCode, playerId, pick }) => {
    const room = rooms[roomCode];
    if (!room || !room.rps) return;

    const { bracket, currentMatchIndex } = room.rps;
    const match = bracket[currentMatchIndex];
    if (!match || match.bye) return;

    const inMatch = match.player1?.id === playerId || match.player2?.id === playerId;
    if (!inMatch) return;

    if (room.rps.picks[playerId]) return;

    room.rps.picks[playerId] = { playerId, pick };

    const player = room.players.find(p => p.id === playerId);
    io.to(roomCode).emit('rps_pick_received', {
      playerId,
      playerName: player?.name || 'Unknown',
    });

    const p1picked = room.rps.picks[match.player1.id];
    const p2picked = room.rps.picks[match.player2.id];

    if (p1picked && p2picked) {
      triggerCountdownAndReveal(roomCode, match, p1picked, p2picked);
    }
  });

  socket.on('roll_dice', ({ roomCode, playerId, playerName, roll }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (!room.rolls) room.rolls = {};
    room.rolls[playerId] = { playerName, roll };
    addLog(room, roomCode, `${playerName} rolled a ${roll}`);
    io.to(roomCode).emit('dice_rolled', { rolls: room.rolls });
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

  socket.on('sync_state', ({ roomCode, players }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.players = players;
    socket.to(roomCode).emit('players_updated', { players });
  });
  socket.on('start_game_now', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    addLog(room, roomCode, 'The game has begun!');
    io.to(roomCode).emit('navigate_to_game');
  });
  
  socket.on('select_minigame', ({ roomCode, option }) => {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit('minigame_selected', { option });
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
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Wither server running on port ${PORT}`);
});