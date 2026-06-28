const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  }
});

const wss = new WebSocket.Server({ server });

const rooms = {}; // roomCode -> gameState

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ─── GAME CONSTANTS ───────────────────────────────────────────
const COLORS = ['red', 'blue', 'green', 'yellow'];
const HOME_POSITIONS = { red: [0,1,2,3], blue: [4,5,6,7], green: [8,9,10,11], yellow: [12,13,14,15] };
const START_CELLS = { red: 1, blue: 14, green: 27, yellow: 40 };
const SAFE_CELLS = [1, 9, 14, 22, 27, 35, 40, 48];
const HOME_COLUMN = {
  red:    [52,53,54,55,56],
  blue:   [57,58,59,60,61],
  green:  [62,63,64,65,66],
  yellow: [67,68,69,70,71]
};
const FINISH_CELL = 72;
const BOARD_CELLS = 52;

function createTokens() {
  const tokens = {};
  COLORS.forEach(c => {
    tokens[c] = [0,1,2,3].map(i => ({ id: i, pos: -1, finished: false }));
  });
  return tokens;
}

function createRoom(hostId) {
  const code = generateCode();
  const state = {
    code,
    players: {},      // ws.id -> { color, name, isAI }
    tokens: createTokens(),
    turnOrder: [...COLORS],
    currentTurn: 0,
    dice: null,
    phase: 'waiting', // waiting | playing | finished
    winner: null,
    aiColors: [],
    aiTimer: null,
  };
  rooms[code] = state;
  return code;
}

function getPlayerColor(state) {
  const usedColors = Object.values(state.players).map(p => p.color);
  return COLORS.find(c => !usedColors.includes(c) && !state.aiColors.includes(c)) || null;
}

function fillWithAI(state) {
  const usedColors = Object.values(state.players).map(p => p.color);
  state.aiColors = [];
  COLORS.forEach(c => {
    if (!usedColors.includes(c)) state.aiColors.push(c);
  });
}

function broadcast(state, msg) {
  const data = JSON.stringify(msg);
  Object.keys(state.players).forEach(id => {
    const p = state.players[id];
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(data);
    }
  });
}

function getMovableTokens(state, color, dice) {
  const tokens = state.tokens[color];
  const movable = [];
  tokens.forEach((t, i) => {
    if (t.finished) return;
    if (t.pos === -1) {
      if (dice === 6) movable.push(i);
    } else {
      const newPos = calcNewPos(t.pos, color, dice);
      if (newPos !== null) movable.push(i);
    }
  });
  return movable;
}

function calcNewPos(currentPos, color, steps) {
  const homeCol = HOME_COLUMN[color];
  const startCell = START_CELLS[color];

  if (currentPos === -1) {
    if (steps !== 6) return null;
    return startCell;
  }

  // Already in home column
  if (homeCol.includes(currentPos)) {
    const idx = homeCol.indexOf(currentPos);
    const newIdx = idx + steps;
    if (newIdx === homeCol.length) return FINISH_CELL;
    if (newIdx > homeCol.length) return null;
    return homeCol[newIdx];
  }

  // On main board
  let newPos = currentPos + steps;

  // Check if passing start to enter home column
  const entryPoint = startCell - 1 === 0 ? BOARD_CELLS : startCell - 1;
  // Simple: each color enters home column after completing full loop
  // Entry trigger: when pos wraps around to their home stretch
  const homeEntry = {
    red: 51, blue: 12, green: 25, yellow: 38
  };

  const entry = homeEntry[color];

  // Check if move crosses entry point
  function crossesEntry(cur, steps) {
    for (let s = 1; s <= steps; s++) {
      const p = ((cur - 1 + s) % BOARD_CELLS) + 1;
      if (p === entry) return s;
    }
    return -1;
  }

  const entryStep = crossesEntry(currentPos, steps);
  if (entryStep !== -1) {
    const remaining = steps - entryStep;
    if (remaining === 0) return homeCol[0];
    if (remaining - 1 < homeCol.length) return homeCol[remaining - 1];
    if (remaining - 1 === homeCol.length) return FINISH_CELL;
    return null; // overshoot
  }

  // Normal board movement
  if (newPos > BOARD_CELLS) newPos = newPos - BOARD_CELLS;
  return newPos;
}

function moveToken(state, color, tokenIdx, dice) {
  const token = state.tokens[color][tokenIdx];
  let captured = false;

  if (token.pos === -1 && dice === 6) {
    token.pos = START_CELLS[color];
  } else {
    const newPos = calcNewPos(token.pos, color, dice);
    if (newPos === null) return false;
    if (newPos === FINISH_CELL) {
      token.pos = FINISH_CELL;
      token.finished = true;
    } else {
      token.pos = newPos;
      // Check capture (only on main board, not safe cells)
      if (!HOME_COLUMN[color].includes(newPos) && !SAFE_CELLS.includes(newPos)) {
        COLORS.forEach(otherColor => {
          if (otherColor === color) return;
          state.tokens[otherColor].forEach(ot => {
            if (ot.pos === newPos && !ot.finished) {
              ot.pos = -1; // send home
              captured = true;
            }
          });
        });
      }
    }
  }
  return { captured };
}

function checkWinner(state) {
  for (const color of COLORS) {
    if (state.tokens[color].every(t => t.finished)) {
      return color;
    }
  }
  return null;
}

function nextTurn(state, extraTurn = false) {
  if (!extraTurn) {
    state.currentTurn = (state.currentTurn + 1) % 4;
  }
  state.dice = null;
  const currentColor = state.turnOrder[state.currentTurn];
  broadcast(state, { type: 'turn', color: currentColor, tokens: state.tokens, dice: null });

  // If AI turn
  if (state.aiColors.includes(currentColor)) {
    clearTimeout(state.aiTimer);
    state.aiTimer = setTimeout(() => doAITurn(state), 600);
  }
}

function doAITurn(state) {
  if (state.phase !== 'playing') return;
  const color = state.turnOrder[state.currentTurn];
  if (!state.aiColors.includes(color)) return;

  const dice = Math.floor(Math.random() * 6) + 1;
  state.dice = dice;
  broadcast(state, { type: 'dice', color, dice, tokens: state.tokens });

  setTimeout(() => {
    const movable = getMovableTokens(state, color, dice);
    if (movable.length === 0) {
      const extraTurn = dice === 6;
      broadcast(state, { type: 'noMove', color, dice });
      nextTurn(state, extraTurn && false); // no extra on no movable
      return;
    }

    // AI strategy: prefer capture, else prefer furthest token
    let chosen = movable[0];
    let bestScore = -1;

    movable.forEach(idx => {
      const token = state.tokens[color][idx];
      let score = 0;
      const newPos = token.pos === -1 ? START_CELLS[color] : calcNewPos(token.pos, color, dice);

      // Check capture
      if (newPos && !HOME_COLUMN[color].includes(newPos) && !SAFE_CELLS.includes(newPos)) {
        COLORS.forEach(oc => {
          if (oc === color) return;
          state.tokens[oc].forEach(ot => { if (ot.pos === newPos) score += 50; });
        });
      }
      // Prefer home column entry
      if (newPos === FINISH_CELL) score += 100;
      if (HOME_COLUMN[color].includes(newPos)) score += 20;
      // Prefer moving out of base
      if (token.pos === -1) score += 10;
      // Prefer further tokens
      if (token.pos > 0) score += token.pos / 10;

      if (score > bestScore) { bestScore = score; chosen = idx; }
    });

    const result = moveToken(state, color, chosen, dice);
    const winner = checkWinner(state);
    if (winner) {
      state.phase = 'finished';
      state.winner = winner;
      broadcast(state, { type: 'winner', color: winner, tokens: state.tokens });
      return;
    }

    const extraTurn = dice === 6 || (result && result.captured);
    broadcast(state, { type: 'moved', color, tokenIdx: chosen, tokens: state.tokens, captured: result ? result.captured : false });
    nextTurn(state, extraTurn);
  }, 250);
}

// ─── WS CONNECTION ────────────────────────────────────────────
let clientId = 0;
wss.on('connection', (ws) => {
  ws.clientId = ++clientId;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'createRoom') {
      const code = createRoom(ws.clientId);
      const state = rooms[code];
      const color = COLORS[0]; // red
      state.players[ws.clientId] = { ws, color, name: msg.name || 'Player 1' };
      ws.roomCode = code;
      ws.send(JSON.stringify({ type: 'roomCreated', code, color, players: getPlayersInfo(state) }));
    }

    else if (msg.type === 'joinRoom') {
      const code = msg.code.toUpperCase();
      const state = rooms[code];
      if (!state) { ws.send(JSON.stringify({ type: 'error', msg: 'Room not found!' })); return; }
      if (state.phase !== 'waiting') { ws.send(JSON.stringify({ type: 'error', msg: 'Game already started!' })); return; }
      if (Object.keys(state.players).length >= 2) { ws.send(JSON.stringify({ type: 'error', msg: 'Room is full!' })); return; }

      const color = getPlayerColor(state);
      state.players[ws.clientId] = { ws, color, name: msg.name || 'Player 2' };
      ws.roomCode = code;

      ws.send(JSON.stringify({ type: 'roomJoined', code, color, players: getPlayersInfo(state) }));
      broadcast(state, { type: 'playerJoined', players: getPlayersInfo(state) });
    }

    else if (msg.type === 'startGame') {
      const state = rooms[ws.roomCode];
      if (!state) return;
      if (Object.keys(state.players).length < 2) { ws.send(JSON.stringify({ type: 'error', msg: 'Need 2 players to start!' })); return; }

      fillWithAI(state);
      state.phase = 'playing';
      state.currentTurn = 0;

      broadcast(state, {
        type: 'gameStarted',
        players: getPlayersInfo(state),
        aiColors: state.aiColors,
        tokens: state.tokens,
        currentColor: state.turnOrder[0]
      });

      // If first turn is AI
      if (state.aiColors.includes(state.turnOrder[0])) {
        setTimeout(() => doAITurn(state), 700);
      }
    }

    else if (msg.type === 'rollDice') {
      const state = rooms[ws.roomCode];
      if (!state || state.phase !== 'playing') return;
      const currentColor = state.turnOrder[state.currentTurn];
      const playerColor = state.players[ws.clientId]?.color;
      if (playerColor !== currentColor) return; // not your turn

      const dice = Math.floor(Math.random() * 6) + 1;
      state.dice = dice;
      broadcast(state, { type: 'dice', color: currentColor, dice, tokens: state.tokens });

      const movable = getMovableTokens(state, currentColor, dice);
      if (movable.length === 0) {
        setTimeout(() => {
          broadcast(state, { type: 'noMove', color: currentColor, dice });
          nextTurn(state, false);
        }, 300);
      } else if (movable.length === 1) {
        // Auto move
        setTimeout(() => {
          const result = moveToken(state, currentColor, movable[0], dice);
          const winner = checkWinner(state);
          if (winner) {
            state.phase = 'finished';
            broadcast(state, { type: 'winner', color: winner, tokens: state.tokens });
            return;
          }
          const extraTurn = dice === 6 || (result && result.captured);
          broadcast(state, { type: 'moved', color: currentColor, tokenIdx: movable[0], tokens: state.tokens, captured: result ? result.captured : false });
          nextTurn(state, extraTurn);
        }, 250);
      } else {
        // Let player choose
        ws.send(JSON.stringify({ type: 'chooseToken', movable, dice }));
      }
    }

    else if (msg.type === 'moveToken') {
      const state = rooms[ws.roomCode];
      if (!state || state.phase !== 'playing') return;
      const currentColor = state.turnOrder[state.currentTurn];
      const playerColor = state.players[ws.clientId]?.color;
      if (playerColor !== currentColor) return;

      const { tokenIdx } = msg;
      const result = moveToken(state, currentColor, tokenIdx, state.dice);
      const winner = checkWinner(state);
      if (winner) {
        state.phase = 'finished';
        broadcast(state, { type: 'winner', color: winner, tokens: state.tokens });
        return;
      }
      const extraTurn = state.dice === 6 || (result && result.captured);
      broadcast(state, { type: 'moved', color: currentColor, tokenIdx, tokens: state.tokens, captured: result ? result.captured : false });
      nextTurn(state, extraTurn);
    }
  });

  ws.on('close', () => {
    const code = ws.roomCode;
    if (!code || !rooms[code]) return;
    const state = rooms[code];
    delete state.players[ws.clientId];
    if (Object.keys(state.players).length === 0) {
      clearTimeout(state.aiTimer);
      delete rooms[code];
    } else {
      broadcast(state, { type: 'playerLeft', players: getPlayersInfo(state) });
    }
  });
});

function getPlayersInfo(state) {
  const info = {};
  Object.values(state.players).forEach(p => {
    info[p.color] = { name: p.name, isAI: false };
  });
  (state.aiColors || []).forEach(c => {
    info[c] = { name: 'AI Bot', isAI: true };
  });
  return info;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎲 Ludo Server running on port ${PORT}!`);
});
