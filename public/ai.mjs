import {
  applyAction,
  alivePieces,
  BOARD_SIZE,
  getLegalActions
} from "./engine.mjs";

const DIFFICULTY = {
  easy: { depth: 1, noise: 38, top: 4 },
  steady: { depth: 4, noise: 10, top: 2 },
  hard: { depth: 6, noise: 0, top: 1 }
};

function rand(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function centerScore(piece) {
  const mid = (BOARD_SIZE - 1) / 2;
  return 8 - Math.abs(piece.row - mid) - Math.abs(piece.col - mid);
}

function advancement(piece) {
  if (piece.king) return 0;
  return piece.owner === 0 ? BOARD_SIZE - 1 - piece.row : piece.row;
}

function threatenedPieces(state, owner) {
  const enemyActions = getLegalActions(state, owner === 0 ? 1 : 0);
  return new Set(enemyActions.filter((action) => action.type === "jump").map((action) => action.captured.id));
}

function evaluate(state, aiPlayer) {
  if (state.winner === aiPlayer) return 100000;
  if (state.winner !== null) return -100000;

  let score = 0;
  const threatenedMine = threatenedPieces(state, aiPlayer);
  const threatenedTheirs = threatenedPieces(state, aiPlayer === 0 ? 1 : 0);

  for (const piece of state.pieces) {
    if (!piece.alive) continue;
    const sign = piece.owner === aiPlayer ? 1 : -1;
    score += sign * (piece.king ? 175 : 100);
    score += sign * centerScore(piece) * (piece.king ? 2.5 : 1.2);
    score += sign * advancement(piece) * 4;
    if ((piece.owner === aiPlayer ? threatenedMine : threatenedTheirs).has(piece.id)) {
      score -= sign * 42;
    }
    if (!piece.king && piece.row === (piece.owner === 0 ? 1 : 6)) score += sign * 14;
  }

  const myActions = getLegalActions(state, aiPlayer);
  const theirActions = getLegalActions(state, aiPlayer === 0 ? 1 : 0);
  score += myActions.length * 2.5 - theirActions.length * 2.5;
  score += myActions.filter((action) => action.type === "jump").length * 20;
  score -= theirActions.filter((action) => action.type === "jump").length * 18;

  const myPieces = alivePieces(state, aiPlayer).length;
  const theirPieces = alivePieces(state, aiPlayer === 0 ? 1 : 0).length;
  if (myPieces + theirPieces <= 8) score += (myPieces - theirPieces) * 35;

  return score;
}

function actionBias(action) {
  let score = 0;
  if (action.type === "jump") score += 100;
  if (action.to.row === 0 || action.to.row === BOARD_SIZE - 1) score += 36;
  score += 8 - Math.abs(action.to.col - 3.5);
  return score;
}

function orderedActions(state) {
  return getLegalActions(state).slice().sort((a, b) => actionBias(b) - actionBias(a));
}

function minimax(state, depth, aiPlayer, alpha, beta) {
  if (depth <= 0 || state.winner !== null) return evaluate(state, aiPlayer);

  const actions = orderedActions(state);
  if (!actions.length) return evaluate(state, aiPlayer);

  const maximizing = state.current === aiPlayer;
  let best = maximizing ? -Infinity : Infinity;

  for (const action of actions) {
    const result = applyAction(state, action);
    if (!result.ok) continue;
    const value = minimax(result.state, depth - 1, aiPlayer, alpha, beta);

    if (maximizing) {
      best = Math.max(best, value);
      alpha = Math.max(alpha, value);
    } else {
      best = Math.min(best, value);
      beta = Math.min(beta, value);
    }

    if (beta <= alpha) break;
  }

  return best;
}

function scoredActions(state, aiPlayer, depth, noise) {
  return orderedActions(state)
    .map((action) => {
      const result = applyAction(state, action);
      const value = result.ok ? minimax(result.state, depth - 1, aiPlayer, -Infinity, Infinity) : -Infinity;
      return {
        action,
        value: value + (noise ? (Math.random() - 0.5) * noise : 0)
      };
    })
    .sort((a, b) => b.value - a.value);
}

export function chooseAiAction(state, difficulty = "steady") {
  const actions = getLegalActions(state);
  if (!actions.length) return null;

  const config = DIFFICULTY[difficulty] || DIFFICULTY.steady;
  if (difficulty === "easy" && Math.random() < 0.24) return rand(actions);

  const scored = scoredActions(state, state.current, config.depth, config.noise);
  const winner = scored.find((entry) => applyAction(state, entry.action).state.winner === state.current);
  if (winner) return winner.action;

  return rand(scored.slice(0, Math.max(1, config.top))).action;
}

export function explainDifficulty(value) {
  return {
    easy: "轻松 AI：更快、更随性。",
    steady: "稳健 AI：会看几步后的吃子和升王。",
    hard: "强手 AI：搜索更深，失误更少。"
  }[value] || "稳健 AI";
}

