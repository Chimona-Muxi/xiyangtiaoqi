export const BOARD_SIZE = 8;

export const PLAYERS = [
  {
    id: 0,
    label: "墨",
    name: "墨方",
    color: "#1f2a27",
    direction: -1,
    kingRow: 0
  },
  {
    id: 1,
    label: "朱",
    name: "朱方",
    color: "#c84f48",
    direction: 1,
    kingRow: 7
  }
];

const ALL_DIRS = [
  { dr: -1, dc: -1 },
  { dr: -1, dc: 1 },
  { dr: 1, dc: -1 },
  { dr: 1, dc: 1 }
];

export function inBounds(row, col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

export function isDarkSquare(row, col) {
  return inBounds(row, col) && (row + col) % 2 === 1;
}

export function cellName(row, col) {
  return `${String.fromCharCode(65 + col)}${BOARD_SIZE - row}`;
}

export function parseCellName(value) {
  const match = String(value || "").trim().toUpperCase().match(/^([A-H])([1-8])$/);
  if (!match) return null;
  return {
    row: BOARD_SIZE - Number(match[2]),
    col: match[1].charCodeAt(0) - 65
  };
}

export function createInitialState(options = {}) {
  const aiSlots = new Set(options.aiSlots || []);
  const names = options.names || [];
  const pieces = [];
  let id = 1;

  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (isDarkSquare(row, col)) {
        pieces.push({ id: `r${id}`, owner: 1, row, col, king: false, alive: true });
        id += 1;
      }
    }
  }

  id = 1;
  for (let row = 5; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (isDarkSquare(row, col)) {
        pieces.push({ id: `b${id}`, owner: 0, row, col, king: false, alive: true });
        id += 1;
      }
    }
  }

  return {
    boardSize: BOARD_SIZE,
    mode: options.mode || "local",
    aiDifficulty: options.aiDifficulty || "steady",
    current: 0,
    turn: 1,
    winner: null,
    chain: null,
    players: PLAYERS.map((player) => ({
      ...player,
      name: names[player.id] || player.name,
      kind: aiSlots.has(player.id) ? "ai" : "human"
    })),
    pieces,
    log: [],
    moveHistory: []
  };
}

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

export function pieceAt(state, row, col) {
  return state.pieces.find((piece) => piece.alive && piece.row === row && piece.col === col) || null;
}

export function alivePieces(state, owner = null) {
  return state.pieces.filter((piece) => piece.alive && (owner === null || piece.owner === owner));
}

function moveDirs(piece) {
  if (piece.king) return ALL_DIRS;
  return ALL_DIRS.filter((dir) => dir.dr === PLAYERS[piece.owner].direction);
}

function actionId(type, piece, row, col) {
  return `${type}:${piece.id}:${cellName(row, col)}`;
}

function actionText(action) {
  const from = cellName(action.from.row, action.from.col);
  const to = cellName(action.to.row, action.to.col);
  if (action.type === "jump") return `${from}x${to}`;
  return `${from}-${to}`;
}

function buildMove(piece, row, col) {
  const action = {
    id: actionId("move", piece, row, col),
    type: "move",
    pieceId: piece.id,
    owner: piece.owner,
    from: { row: piece.row, col: piece.col },
    to: { row, col }
  };
  action.text = actionText(action);
  return action;
}

function buildJump(piece, row, col, captured) {
  const action = {
    id: actionId("jump", piece, row, col),
    type: "jump",
    pieceId: piece.id,
    owner: piece.owner,
    from: { row: piece.row, col: piece.col },
    to: { row, col },
    captured: { id: captured.id, row: captured.row, col: captured.col }
  };
  action.text = actionText(action);
  return action;
}

function pieceMoves(state, piece) {
  const result = [];
  for (const dir of moveDirs(piece)) {
    const row = piece.row + dir.dr;
    const col = piece.col + dir.dc;
    if (isDarkSquare(row, col) && !pieceAt(state, row, col)) result.push(buildMove(piece, row, col));
  }
  return result;
}

function pieceJumps(state, piece) {
  const result = [];
  for (const dir of moveDirs(piece)) {
    const midRow = piece.row + dir.dr;
    const midCol = piece.col + dir.dc;
    const row = piece.row + dir.dr * 2;
    const col = piece.col + dir.dc * 2;
    const captured = pieceAt(state, midRow, midCol);
    if (
      isDarkSquare(row, col)
      && captured
      && captured.owner !== piece.owner
      && !pieceAt(state, row, col)
    ) {
      result.push(buildJump(piece, row, col, captured));
    }
  }
  return result;
}

function legalActionsRaw(state, playerId = state.current) {
  if (state.chain && state.chain.player === playerId) {
    const piece = state.pieces.find((item) => item.alive && item.id === state.chain.pieceId && item.owner === playerId);
    return piece ? pieceJumps(state, piece) : [];
  }

  const pieces = alivePieces(state, playerId);
  const jumps = pieces.flatMap((piece) => pieceJumps(state, piece));
  if (jumps.length) return jumps;
  return pieces.flatMap((piece) => pieceMoves(state, piece));
}

export function getLegalActions(state, playerId = state.current) {
  if (state.winner !== null) return [];
  return legalActionsRaw(state, playerId);
}

function resolveAction(state, input, playerId = state.current) {
  const actions = getLegalActions(state, playerId);
  const id = typeof input === "string" ? input : input?.id;
  if (id) return actions.find((action) => action.id === id) || null;

  if (!input || typeof input !== "object") return null;
  return actions.find((action) => (
    action.type === input.type
    && action.pieceId === input.pieceId
    && action.to.row === Number(input.to?.row ?? input.row)
    && action.to.col === Number(input.to?.col ?? input.col)
  )) || null;
}

function crownIfNeeded(piece) {
  const player = PLAYERS[piece.owner];
  if (!piece.king && piece.row === player.kingRow) {
    piece.king = true;
    return true;
  }
  return false;
}

function nextPlayer(playerId) {
  return playerId === 0 ? 1 : 0;
}

function winnerAfterTurn(state, previousPlayer) {
  const opponent = nextPlayer(previousPlayer);
  if (alivePieces(state, opponent).length === 0) return previousPlayer;
  if (legalActionsRaw(state, opponent).length === 0) return previousPlayer;
  return null;
}

function logEntry(state, text) {
  state.log.unshift({ turn: state.turn, player: state.current, text });
  state.log = state.log.slice(0, 80);
  state.moveHistory.unshift(text);
  state.moveHistory = state.moveHistory.slice(0, 120);
}

export function applyAction(state, input) {
  const action = resolveAction(state, input, state.current);
  if (!action) return { ok: false, reason: "这步不合法", state };

  const next = cloneState(state);
  const piece = next.pieces.find((item) => item.alive && item.id === action.pieceId);
  if (!piece) return { ok: false, reason: "棋子不存在", state };

  const playerId = next.current;
  const wasKing = piece.king;
  piece.row = action.to.row;
  piece.col = action.to.col;

  if (action.type === "jump") {
    const captured = next.pieces.find((item) => item.alive && item.id === action.captured.id);
    if (captured) captured.alive = false;
  }

  const becameKing = crownIfNeeded(piece);
  logEntry(next, `${next.players[playerId].name} ${action.text}${becameKing ? "，升王" : ""}`);

  if (action.type === "jump" && wasKing === piece.king) {
    const more = pieceJumps(next, piece);
    if (more.length) {
      next.chain = { player: playerId, pieceId: piece.id };
      next.turn += 1;
      return { ok: true, state: next, action, continued: true };
    }
  }

  next.chain = null;
  const winner = winnerAfterTurn(next, playerId);
  if (winner !== null) {
    next.winner = winner;
  } else {
    next.current = nextPlayer(playerId);
  }
  next.turn += 1;
  return { ok: true, state: next, action, continued: false };
}

export function scoreSummary(state) {
  return state.players.map((player) => {
    const pieces = alivePieces(state, player.id);
    const kings = pieces.filter((piece) => piece.king).length;
    return {
      id: player.id,
      name: player.name,
      pieces: pieces.length,
      kings
    };
  });
}

export function mustCapture(state, playerId = state.current) {
  if (state.chain && state.chain.player === playerId) return true;
  return alivePieces(state, playerId).some((piece) => pieceJumps(state, piece).length > 0);
}

