const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;
const QUICK_MATCH_WAIT = 15;
const PRIVATE_LOBBY_WAIT = 30;

const BOT_POOL = [
  { name: 'Ace McGee', diff: 2, speed: 640 },
  { name: 'Queen B', diff: 1, speed: 960 },
  { name: 'Jack Flash', diff: 1, speed: 1120 },
  { name: 'King Kong', diff: 0, speed: 1750 }
];

const app = express();
app.use(cors());
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const rooms = new Map();
let queueRoomCode = null;

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function makeRng(seed) {
  let s = (seed ^ 0xdeadbeef) >>> 0;
  return function () {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function shuffleDeck(seed) {
  const suits = ['s','h','c','d'];
  const ranks = ['a','2','3','4','5','6','7','8','9','10','j','q','k'];
  const rng = makeRng(seed);
  const d = [];
  for (let si = 0; si < 4; si++) for (let ri = 0; ri < 13; ri++) d.push({ suit: suits[si], rank: ranks[ri], ri, face: false });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function rankVal(rank) {
  return rank === 'a' ? 1 : rank === 'j' ? 11 : rank === 'q' ? 12 : rank === 'k' ? 13 : parseInt(rank, 10);
}

function isRed(suit) {
  return suit === 'h' || suit === 'd';
}

function createBotState(idx, seed) {
  const base = BOT_POOL[idx % BOT_POOL.length];
  const bot = {
    id: `bot${idx}`,
    name: base.name,
    diff: base.diff,
    speed: base.speed + Math.floor(Math.random() * 180),
    stock: [],
    waste: [],
    found: [[], [], [], []],
    tab: [[], [], [], [], [], [], []],
    foundCount: 0,
    done: false,
    rank: 0,
    finishTime: 0,
    interval: null,
    stockPasses: 0,
    noProgress: 0,
    moves: 0,
  };
  const deck = shuffleDeck(seed);
  let p = 0;
  for (let col = 0; col < 7; col++) {
    for (let row = 0; row <= col; row++) {
      const c = deck[p++];
      c.face = row === col;
      bot.tab[col].push(c);
    }
  }
  while (p < 52) {
    const c = deck[p++];
    c.face = false;
    bot.stock.push(c);
  }
  return bot;
}

function canFound(card, pile) {
  if (!pile.length) return card.rank === 'a';
  const top = pile[pile.length - 1];
  return card.suit === top.suit && rankVal(card.rank) === rankVal(top.rank) + 1;
}

function canTab(card, on) {
  if (!on || !on.face || card.rank === 'a') return false;
  return isRed(card.suit) !== isRed(on.suit) && rankVal(card.rank) === rankVal(on.rank) - 1;
}

function getBotMove(bot) {
  const moves = [];
  if (!bot.stock.length && !bot.waste.length) {
    for (let col = 0; col < 7; col++) {
      const a = bot.tab[col];
      if (a.length && !a[a.length - 1].face) return { sc: 999, act: 'flip', col };
    }
    for (let col = 0; col < 7; col++) {
      const a = bot.tab[col];
      if (a.length && a[a.length - 1].face) {
        for (let f = 0; f < 4; f++) if (canFound(a[a.length - 1], bot.found[f])) return { sc: 999, act: 'tf', col, f };
      }
    }
    return null;
  }
  if (bot.waste.length) {
    const wc = bot.waste[bot.waste.length - 1];
    for (let f = 0; f < 4; f++) if (canFound(wc, bot.found[f])) moves.push({ sc: 200, act: 'wf', f });
  }
  for (let col = 0; col < 7; col++) {
    const a = bot.tab[col];
    if (a.length && a[a.length - 1].face) {
      for (let f = 0; f < 4; f++) if (canFound(a[a.length - 1], bot.found[f])) moves.push({ sc: 190, act: 'tf', col, f });
    }
  }
  for (let col = 0; col < 7; col++) {
    const a = bot.tab[col];
    if (!a.length) continue;
    let sr = a.length - 1;
    while (sr > 0 && a[sr - 1].face) sr--;
    if (!a[sr].face) continue;
    const top = a[sr];
    const reveals = sr > 0 && !a[sr - 1].face;
    for (let dc = 0; dc < 7; dc++) {
      if (dc === col) continue;
      const dest = bot.tab[dc];
      const ok = dest.length === 0 ? (top.rank === 'k' && (reveals || sr > 0)) : canTab(top, dest[dest.length - 1]);
      if (ok) moves.push({ sc: reveals ? 160 : (dest.length === 0 ? 12 : 55), act: 'tt', fc: col, fr: sr, tc: dc });
    }
  }
  if (bot.waste.length) {
    const wc = bot.waste[bot.waste.length - 1];
    for (let dc = 0; dc < 7; dc++) {
      const dest = bot.tab[dc];
      const ok = dest.length === 0 ? wc.rank === 'k' : canTab(wc, dest[dest.length - 1]);
      if (ok) moves.push({ sc: dest.length === 0 ? 18 : 75, act: 'wt', tc: dc });
    }
  }
  if (bot.stock.length) moves.push({ sc: Math.max(5, 35 - bot.noProgress), act: 'draw' });
  if (!bot.stock.length && bot.waste.length && bot.stockPasses < 4) moves.push({ sc: 8, act: 'cycle' });
  if (!moves.length) return null;
  moves.sort((a, b) => b.sc - a.sc);
  if (bot.diff === 0 && Math.random() < 0.28 && moves.length > 1) return moves[Math.floor(Math.random() * Math.min(3, moves.length))];
  return moves[0];
}

function applyBotMove(bot, move) {
  const prevFound = bot.foundCount;
  switch (move.act) {
    case 'flip':
      bot.tab[move.col][bot.tab[move.col].length - 1].face = true;
      break;
    case 'wf':
      bot.found[move.f].push(bot.waste.pop());
      break;
    case 'tf': {
      bot.found[move.f].push(bot.tab[move.col].pop());
      const stack = bot.tab[move.col];
      if (stack.length && !stack[stack.length - 1].face) stack[stack.length - 1].face = true;
      break;
    }
    case 'tt': {
      const moved = bot.tab[move.fc].splice(move.fr);
      moved.forEach((c) => bot.tab[move.tc].push(c));
      const stack = bot.tab[move.fc];
      if (stack.length && !stack[stack.length - 1].face) stack[stack.length - 1].face = true;
      break;
    }
    case 'wt':
      bot.tab[move.tc].push(bot.waste.pop());
      break;
    case 'draw': {
      const n = Math.min(3, bot.stock.length);
      for (let i = 0; i < n; i++) {
        const c = bot.stock.pop();
        c.face = true;
        bot.waste.push(c);
      }
      break;
    }
    case 'cycle':
      while (bot.waste.length) {
        const c = bot.waste.pop();
        c.face = false;
        bot.stock.push(c);
      }
      bot.stockPasses++;
      break;
  }
  bot.moves++;
  bot.foundCount = bot.found.reduce((sum, pile) => sum + pile.length, 0);
  if (bot.foundCount > prevFound) bot.noProgress = 0; else bot.noProgress++;
}


// --- Solvable Deal Picker ---
// The server only starts online rooms with seeds that the built-in solver can finish.
// This keeps Quick Match and Private online races on winnable hands.
const SOLVABLE_FALLBACK_SEEDS = [20,31,98,139,145,170,207,295,411,435,518,617,829,943,1009,1217,1381,1607,1789,1999];
let solvableSeedCursor = 0;

function isSeedSolvable(seed) {
  const bot = createBotState(0, seed);
  bot.diff = 2;
  bot.speed = 0;
  for (let step = 0; step < 5000; step++) {
    if (bot.foundCount >= 52) return true;
    const move = getBotMove(bot);
    if (!move) return false;
    applyBotMove(bot, move);
  }
  return bot.foundCount >= 52;
}

function pickSolvableSeed() {
  const base = Math.floor(Math.random() * 999983) + 1;
  for (let attempt = 0; attempt < 700; attempt++) {
    const seed = ((base + attempt * 9973) % 999983) + 1;
    if (isSeedSolvable(seed)) return seed;
  }
  const fallback = SOLVABLE_FALLBACK_SEEDS[solvableSeedCursor % SOLVABLE_FALLBACK_SEEDS.length];
  solvableSeedCursor++;
  return fallback;
}

function summarizeParticipant(p) {
  return {
    id: p.id,
    name: p.name,
    foundCount: p.foundCount || 0,
    done: !!p.done,
    rank: p.rank || 0,
    finishTime: p.finishTime || 0,
    disconnected: !!p.disconnected,
  };
}

function summarizeRoom(room) {
  return {
    roomCode: room.roomCode,
    mode: room.mode,
    hostId: room.hostId,
    secondsLeft: room.secondsLeft,
    players: room.players.map(summarizeParticipant),
    bots: room.bots.map(summarizeParticipant),
  };
}

function emitRoomState(room, eventName = 'room_state') {
  io.to(room.roomCode).emit(eventName, summarizeRoom(room));
}

function stopRoomTimers(room) {
  if (room.countdownInterval) clearInterval(room.countdownInterval);
  room.countdownInterval = null;
  room.bots.forEach((bot) => { if (bot.interval) clearInterval(bot.interval); bot.interval = null; });
}

function assignRank(room, participant, finishTime) {
  if (participant.done) return;
  participant.done = true;
  participant.finishTime = finishTime || participant.finishTime || 0;
  const currentRanks = room.players.concat(room.bots).filter((p) => p.rank).length;
  participant.rank = currentRanks + 1;
}

function maybeEndRace(room) {
  const everyoneDone = room.players.concat(room.bots).every((p) => p.done);
  if (!everyoneDone) return;
  io.to(room.roomCode).emit('race_over', summarizeRoom(room));
}

function startBots(room) {
  room.bots.forEach((bot) => {
    if (bot.interval) clearInterval(bot.interval);
    bot.interval = setInterval(() => {
      if (bot.done || !room.started) {
        clearInterval(bot.interval);
        bot.interval = null;
        return;
      }
      const move = getBotMove(bot);
      if (!move) {
        assignRank(room, bot, Date.now() - room.raceStartTime);
        io.to(room.roomCode).emit('finished', { pid: bot.id, time: bot.finishTime });
        maybeEndRace(room);
        clearInterval(bot.interval);
        bot.interval = null;
        return;
      }
      applyBotMove(bot, move);
      io.to(room.roomCode).emit('progress', { pid: bot.id, fc: bot.foundCount });
      if (bot.foundCount >= 52) {
        assignRank(room, bot, Date.now() - room.raceStartTime);
        io.to(room.roomCode).emit('finished', { pid: bot.id, time: bot.finishTime });
        maybeEndRace(room);
        clearInterval(bot.interval);
        bot.interval = null;
      }
    }, bot.speed);
  });
}

function fillBots(room) {
  room.bots = [];
  const open = Math.max(0, room.maxPlayers - room.players.length);
  for (let i = 0; i < open; i++) room.bots.push(createBotState(i, room.seed));
}

function startRace(room) {
  if (room.started) return;
  stopRoomTimers(room);
  fillBots(room);
  room.started = true;
  room.raceStartTime = Date.now();
  emitRoomState(room);
  io.to(room.roomCode).emit('start_race', {
    roomCode: room.roomCode,
    seed: room.seed,
    transport: 'online',
    players: room.players.map(summarizeParticipant),
    bots: room.bots.map(summarizeParticipant),
  });
  startBots(room);
}

function createRoom(mode, hostSocketId, hostPlayerId, hostName, waitSeconds, maxPlayers) {
  let roomCode;
  do { roomCode = randomCode(); } while (rooms.has(roomCode));
  const room = {
    roomCode,
    mode,
    hostSocketId,
    hostId: hostPlayerId,
    seed: pickSolvableSeed(),
    waitSeconds,
    secondsLeft: waitSeconds,
    maxPlayers: Math.max(2, Math.min(maxPlayers || MAX_PLAYERS, MAX_PLAYERS)),
    players: [{ id: hostPlayerId, name: hostName || 'Player', socketId: hostSocketId, foundCount: 0, done: false, rank: 0, finishTime: 0 }],
    bots: [],
    countdownInterval: null,
    started: false,
    raceStartTime: 0,
  };
  room.countdownInterval = setInterval(() => {
    room.secondsLeft--;
    if (room.secondsLeft <= 0) {
      startRace(room);
    } else {
      emitRoomState(room, room.mode === 'queue' ? 'queue_status' : 'room_state');
    }
  }, 1000);
  rooms.set(roomCode, room);
  return room;
}

function getRoomByPlayer(pid) {
  for (const room of rooms.values()) {
    if (room.players.some((p) => p.id === pid)) return room;
  }
  return null;
}

function removePlayerFromRoom(room, pid) {
  room.players = room.players.filter((p) => p.id !== pid);
  if (!room.players.length) {
    stopRoomTimers(room);
    rooms.delete(room.roomCode);
    if (queueRoomCode === room.roomCode) queueRoomCode = null;
    return;
  }
  if (room.hostId === pid) {
    room.hostId = room.players[0].id;
    room.hostSocketId = room.players[0].socketId;
  }
  emitRoomState(room, room.mode === 'queue' ? 'queue_status' : 'room_state');
}

io.on('connection', (socket) => {
  socket.on('queue_join', ({ pid, name, maxPlayers, waitSeconds }) => {
    let room = queueRoomCode ? rooms.get(queueRoomCode) : null;
    if (!room || room.started || room.players.length >= (room.maxPlayers || MAX_PLAYERS)) {
      room = createRoom('queue', socket.id, pid, name, waitSeconds || QUICK_MATCH_WAIT, maxPlayers || MAX_PLAYERS);
      queueRoomCode = room.roomCode;
    } else {
      room.players.push({ id: pid, name: name || 'Player', socketId: socket.id, foundCount: 0, done: false, rank: 0, finishTime: 0 });
    }
    socket.join(room.roomCode);
    emitRoomState(room, 'queue_status');
    if (room.players.length >= room.maxPlayers) {
      queueRoomCode = null;
      startRace(room);
    }
  });

  socket.on('create_room', ({ pid, name, lobbySeconds, maxPlayers }) => {
    const room = createRoom('private', socket.id, pid, name, lobbySeconds || PRIVATE_LOBBY_WAIT, maxPlayers || MAX_PLAYERS);
    socket.join(room.roomCode);
    emitRoomState(room);
  });

  socket.on('join_room', ({ roomCode, pid, name }) => {
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('error_msg', { message: 'Room not found' });
    if (room.started) return socket.emit('error_msg', { message: 'Race already started' });
    if (room.players.length >= room.maxPlayers) return socket.emit('error_msg', { message: 'Room is full' });
    if (room.players.some((p) => p.id === pid)) return;
    room.players.push({ id: pid, name: name || 'Player', socketId: socket.id, foundCount: 0, done: false, rank: 0, finishTime: 0 });
    socket.join(room.roomCode);
    emitRoomState(room);
  });

  socket.on('force_start', ({ roomCode, pid }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.hostId !== pid) return;
    startRace(room);
  });

  socket.on('progress', ({ roomCode, pid, fc }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.started) return;
    const player = room.players.find((p) => p.id === pid);
    if (!player || player.done) return;
    const safeFc = Math.max(player.foundCount || 0, Math.min(52, Number(fc) || 0));
    if (safeFc > player.foundCount + 13) return;
    player.foundCount = safeFc;
    socket.to(room.roomCode).emit('progress', { pid, fc: safeFc });
  });

  socket.on('finished', ({ roomCode, pid, time, foundCount }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.started) return;
    const player = room.players.find((p) => p.id === pid);
    if (!player || player.done) return;
    player.foundCount = Math.max(52, foundCount || player.foundCount || 52);
    assignRank(room, player, Math.max(1000, Number(time) || 0));
    io.to(room.roomCode).emit('finished', { pid, time: player.finishTime });
    maybeEndRace(room);
  });

  socket.on('request_race_over', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const remaining = room.players.concat(room.bots).filter((p) => !p.done).sort((a, b) => (b.foundCount || 0) - (a.foundCount || 0));
    remaining.forEach((p) => assignRank(room, p, 0));
    io.to(room.roomCode).emit('race_over', summarizeRoom(room));
  });

  socket.on('leave_room', ({ roomCode, pid }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    socket.leave(roomCode);
    removePlayerFromRoom(room, pid);
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = room.players.find((p) => p.socketId === socket.id);
      if (!player) continue;
      if (room.started) {
        player.disconnected = true;
        assignRank(room, player, Date.now() - room.raceStartTime);
        io.to(room.roomCode).emit('finished', { pid: player.id, time: player.finishTime });
        maybeEndRace(room);
      } else {
        removePlayerFromRoom(room, player.id);
      }
      break;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Sweets Solitaire multiplayer server listening on ${PORT}`);
});
