import {
  applyAction,
  cellName,
  createInitialState,
  getLegalActions,
  mustCapture,
  pieceAt,
  scoreSummary
} from "./engine.mjs";
import { chooseAiAction, explainDifficulty } from "./ai.mjs";

const els = {
  board: document.querySelector("#board"),
  modeCaption: document.querySelector("#modeCaption"),
  modeButtons: [...document.querySelectorAll(".mode-button")],
  aiPanel: document.querySelector("#aiPanel"),
  localPanel: document.querySelector("#localPanel"),
  onlinePanel: document.querySelector("#onlinePanel"),
  difficulty: document.querySelector("#difficultySelect"),
  newGame: document.querySelector("#newGameButton"),
  newLocal: document.querySelector("#newLocalButton"),
  onlineName: document.querySelector("#onlineNameInput"),
  createRoom: document.querySelector("#createRoomButton"),
  showJoin: document.querySelector("#showJoinButton"),
  joinBack: document.querySelector("#joinBackButton"),
  joinCode: document.querySelector("#joinCodeInput"),
  joinRoom: document.querySelector("#joinRoomButton"),
  onlineHome: document.querySelector("#onlineHomeStep"),
  onlineJoin: document.querySelector("#onlineJoinStep"),
  onlineRoom: document.querySelector("#onlineRoomStep"),
  roomCode: document.querySelector("#roomCodeText"),
  copyRoom: document.querySelector("#copyRoomButton"),
  leaveRoom: document.querySelector("#leaveRoomButton"),
  playerCards: document.querySelector("#playerCards"),
  turnMeta: document.querySelector("#turnMeta"),
  statusTitle: document.querySelector("#statusTitle"),
  capturePill: document.querySelector("#capturePill"),
  chainPill: document.querySelector("#chainPill"),
  metrics: document.querySelector("#metrics"),
  logList: document.querySelector("#logList"),
  toast: document.querySelector("#toast")
};

const modeText = {
  ai: "人机对弈",
  local: "同屏对战",
  online: "房间联机"
};

let mode = "ai";
let game = createGame();
let selectedPieceId = "";
let aiTimer = 0;
let toastTimer = 0;
let onlineRoom = null;
let onlineStep = "home";
let eventSource = null;
let clientId = getClientId();

function getClientId() {
  const key = "checkers-client-id";
  let value = localStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    localStorage.setItem(key, value);
  }
  return value;
}

function activeRoomKey() {
  return "checkers-active-room";
}

function saveActiveRoom(room) {
  localStorage.setItem(activeRoomKey(), JSON.stringify({ code: room.code }));
}

function clearActiveRoom() {
  localStorage.removeItem(activeRoomKey());
}

function createGame() {
  return createInitialState({
    mode,
    aiDifficulty: els.difficulty?.value || "steady",
    aiSlots: mode === "ai" ? [1] : [],
    names: mode === "ai" ? ["你", "AI"] : ["墨方", "朱方"]
  });
}

async function api(path, body = null, options = {}) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1800);
}

function closeEvents() {
  if (eventSource) eventSource.close();
  eventSource = null;
}

function withRoom(room) {
  onlineRoom = room;
  game = room.state;
  selectedPieceId = game.chain?.pieceId || "";
  render();
}

function connectRoom(code) {
  closeEvents();
  eventSource = new EventSource(`/api/rooms/${code}/events?clientId=${encodeURIComponent(clientId)}`);
  eventSource.onmessage = (event) => {
    const room = JSON.parse(event.data);
    withRoom(room);
  };
  eventSource.onerror = () => {
    closeEvents();
  };
}

async function restoreRoom() {
  const saved = JSON.parse(localStorage.getItem(activeRoomKey()) || "null");
  if (!saved?.code) return;
  try {
    const room = await api(`/api/rooms/${saved.code}?clientId=${encodeURIComponent(clientId)}`);
    mode = "online";
    onlineStep = "room";
    withRoom(room);
    connectRoom(room.code);
  } catch {
    clearActiveRoom();
  }
}

function resetOfflineGame() {
  closeEvents();
  onlineRoom = null;
  selectedPieceId = "";
  game = createGame();
  render();
  queueAi();
}

function setMode(nextMode) {
  if (mode === nextMode) return;
  mode = nextMode;
  selectedPieceId = "";
  clearTimeout(aiTimer);
  closeEvents();
  onlineRoom = null;
  onlineStep = "home";
  if (mode !== "online") clearActiveRoom();
  game = createGame();
  render();
  queueAi();
}

function currentPlayer() {
  return game.players[game.current];
}

function myOnlineSeat() {
  return onlineRoom?.mySeat ?? -1;
}

function actionLockedReason() {
  if (game.winner !== null) return "本局已经结束";
  if (mode === "ai" && currentPlayer()?.kind === "ai") return "AI 思考中";
  if (mode === "online") {
    if (!onlineRoom?.started) return "等待对手入座";
    if (myOnlineSeat() !== game.current) return "还没轮到你";
  }
  return "";
}

function canAct() {
  return !actionLockedReason();
}

function actionsForSelected() {
  if (!selectedPieceId) return [];
  return getLegalActions(game).filter((action) => action.pieceId === selectedPieceId);
}

function findActionTo(row, col) {
  return actionsForSelected().find((action) => action.to.row === row && action.to.col === col) || null;
}

function selectPiece(piece) {
  if (!piece || piece.owner !== game.current) return false;
  const actions = getLegalActions(game).filter((action) => action.pieceId === piece.id);
  if (!actions.length) return false;
  selectedPieceId = piece.id;
  render();
  return true;
}

async function submitAction(action) {
  if (!action) return;
  if (mode === "online") {
    try {
      const room = await api(`/api/rooms/${onlineRoom.code}/action`, { clientId, action });
      withRoom(room);
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  const result = applyAction(game, action);
  if (!result.ok) return showToast(result.reason || "这步不合法");
  game = result.state;
  selectedPieceId = game.chain?.pieceId || "";
  render();
  queueAi();
}

function onSquareClick(row, col) {
  const reason = actionLockedReason();
  if (reason) return showToast(reason);

  const piece = pieceAt(game, row, col);
  if (piece?.owner === game.current && selectPiece(piece)) return;

  const action = findActionTo(row, col);
  if (action) return submitAction(action);

  if (mustCapture(game)) showToast("这一手必须吃子");
  else showToast("请选择可移动的棋子");
}

function queueAi() {
  clearTimeout(aiTimer);
  if (mode !== "ai" || game.winner !== null || currentPlayer()?.kind !== "ai") return;
  aiTimer = setTimeout(() => {
    const action = chooseAiAction(game, game.aiDifficulty);
    if (!action) return;
    const result = applyAction(game, action);
    if (result.ok) {
      game = result.state;
      selectedPieceId = game.chain?.pieceId || "";
      render();
      queueAi();
    }
  }, 420);
}

async function createOnlineRoom() {
  try {
    const room = await api("/api/rooms", { clientId, name: els.onlineName.value });
    onlineStep = "room";
    withRoom(room);
    saveActiveRoom(room);
    connectRoom(room.code);
    showToast("房间已创建");
  } catch (error) {
    showToast(error.message);
  }
}

async function joinOnlineRoom() {
  const code = els.joinCode.value.trim().toUpperCase();
  if (!code) return showToast("请输入房间码");
  try {
    const room = await api(`/api/rooms/${code}/join`, { clientId, name: els.onlineName.value });
    onlineStep = "room";
    withRoom(room);
    saveActiveRoom(room);
    connectRoom(room.code);
    showToast("已加入房间");
  } catch (error) {
    showToast(error.message);
  }
}

function leaveRoom() {
  clearActiveRoom();
  closeEvents();
  onlineRoom = null;
  onlineStep = "home";
  game = createGame();
  render();
}

function pieceClass(piece) {
  return piece.owner === 0 ? "black" : "red";
}

function renderBoard() {
  const actions = actionsForSelected();
  const targetMap = new Map(actions.map((action) => [`${action.to.row},${action.to.col}`, action]));
  els.board.innerHTML = "";

  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const square = document.createElement("button");
      square.type = "button";
      square.className = `square ${(row + col) % 2 ? "dark" : "light"}`;
      square.dataset.cell = cellName(row, col);
      square.setAttribute("aria-label", cellName(row, col));
      square.addEventListener("click", () => onSquareClick(row, col));

      const action = targetMap.get(`${row},${col}`);
      if (action) square.classList.add(action.type === "jump" ? "capture-target" : "target");

      const piece = pieceAt(game, row, col);
      if (piece) {
        const pieceEl = document.createElement("div");
        pieceEl.className = `piece ${pieceClass(piece)}${piece.king ? " king" : ""}`;
        pieceEl.textContent = piece.king ? "" : game.players[piece.owner].label;
        square.append(pieceEl);
        if (piece.id === selectedPieceId) square.classList.add("selected");
      }

      els.board.append(square);
    }
  }
}

function renderPlayers() {
  els.playerCards.innerHTML = game.players.map((player) => {
    const seat = onlineRoom?.seats?.[player.id];
    const suffix = mode === "online"
      ? seat?.occupied ? (seat.connected ? "在线" : "已入座") : "等待"
      : player.kind === "ai" ? "AI" : "玩家";
    return `
      <div class="player-card ${game.current === player.id && game.winner === null ? "active" : ""}">
        <span class="player-dot" style="background:${player.color}"></span>
        <div>
          <strong>${player.name}</strong>
          <small>${player.label}方 · ${suffix}</small>
        </div>
        <small>${player.id === 0 ? "先手" : "后手"}</small>
      </div>
    `;
  }).join("");
}

function renderMetrics() {
  els.metrics.innerHTML = scoreSummary(game).map((item) => `
    <div class="metric">
      <span>${item.name}</span>
      <strong>${item.pieces} / ${item.kings}</strong>
    </div>
  `).join("");
}

function renderLog() {
  const logs = game.log || [];
  els.logList.innerHTML = logs.length
    ? logs.map((entry) => `<div class="log-item">${entry.text}</div>`).join("")
    : `<div class="log-item">暂无记录</div>`;
}

function renderStatus() {
  els.modeCaption.textContent = modeText[mode];
  els.turnMeta.textContent = game.winner !== null ? "终局" : `第 ${game.turn} 手`;

  if (game.winner !== null) {
    els.statusTitle.textContent = `${game.players[game.winner].name} 获胜`;
  } else if (mode === "online" && !onlineRoom?.started) {
    els.statusTitle.textContent = "等待对手";
  } else if (mode === "online" && myOnlineSeat() !== game.current) {
    els.statusTitle.textContent = `轮到 ${currentPlayer().name}`;
  } else if (mode === "ai" && currentPlayer()?.kind === "ai") {
    els.statusTitle.textContent = "AI 思考中";
  } else {
    els.statusTitle.textContent = `轮到 ${currentPlayer().name}`;
  }

  els.capturePill.classList.toggle("active", mustCapture(game));
  els.chainPill.classList.toggle("active", Boolean(game.chain));
}

function renderPanels() {
  els.modeButtons.forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  els.aiPanel.classList.toggle("hidden", mode !== "ai");
  els.localPanel.classList.toggle("hidden", mode !== "local");
  els.onlinePanel.classList.toggle("hidden", mode !== "online");
  els.onlineHome.classList.toggle("hidden", onlineStep !== "home");
  els.onlineJoin.classList.toggle("hidden", onlineStep !== "join");
  els.onlineRoom.classList.toggle("hidden", onlineStep !== "room");
  if (onlineRoom) els.roomCode.textContent = onlineRoom.code;
}

function render() {
  if (game.chain?.pieceId && !selectedPieceId) selectedPieceId = game.chain.pieceId;
  renderPanels();
  renderStatus();
  renderBoard();
  renderPlayers();
  renderMetrics();
  renderLog();
}

els.modeButtons.forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

els.difficulty.addEventListener("change", resetOfflineGame);
els.newGame.addEventListener("click", resetOfflineGame);
els.newLocal.addEventListener("click", resetOfflineGame);
els.createRoom.addEventListener("click", createOnlineRoom);
els.showJoin.addEventListener("click", () => {
  onlineStep = "join";
  render();
  els.joinCode.focus();
});
els.joinBack.addEventListener("click", () => {
  onlineStep = "home";
  render();
});
els.joinRoom.addEventListener("click", joinOnlineRoom);
els.leaveRoom.addEventListener("click", leaveRoom);
els.copyRoom.addEventListener("click", async () => {
  await navigator.clipboard?.writeText(onlineRoom?.code || "");
  showToast("房间码已复制");
});
els.joinCode.addEventListener("input", () => {
  els.joinCode.value = els.joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
});

render();
restoreRoom();
queueAi();

window.addEventListener("beforeunload", closeEvents);

console.info(explainDifficulty(els.difficulty.value));
