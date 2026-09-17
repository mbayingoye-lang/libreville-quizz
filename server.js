const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const rooms = new Map();
const MAX_PLAYERS = 2;
const QUESTIONS_PER_MATCH = 15;
const QUESTION_SECONDS = 20;

function code() {
  let c;
  do c = crypto.randomBytes(3).toString('hex').toUpperCase();
  while (rooms.has(c));
  return c;
}
function id() { return crypto.randomUUID(); }
function name(v) { return String(v || 'Joueur').trim().slice(0, 30) || 'Joueur'; }
function send(ws, type, data = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
}
function state(room) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    rubric: room.rubric,
    questionNumber: room.questionNumber,
    totalQuestions: room.totalQuestions,
    timeLeft: room.timeLeft,
    buzzedPlayer: room.buzzedPlayer,
    answerPhase: room.answerPhase,
    players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score,
      connected: p.ws.readyState === WebSocket.OPEN
    }))
  };
}
function broadcast(room, type, data = {}) {
  room.players.forEach(p => send(p.ws, type, data));
}
function sync(room) { broadcast(room, 'room_state', { state: state(room) }); }
function stopTimer(room) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
}
function resetQuestion(room) {
  stopTimer(room);
  room.questionToken = id();
  room.timeLeft = QUESTION_SECONDS;
  room.buzzedPlayer = null;
  room.answerPhase = false;
  room.questionLocked = false;
}
function startTimer(room) {
  const token = room.questionToken;
  const started = Date.now();
  stopTimer(room);
  room.timer = setInterval(() => {
    if (!rooms.has(room.code) || room.questionToken !== token || room.questionLocked || room.answerPhase) {
      stopTimer(room); return;
    }
    room.timeLeft = Math.max(0, QUESTION_SECONDS - Math.floor((Date.now() - started) / 1000));
    broadcast(room, 'timer', { timeLeft: room.timeLeft });
    if (room.timeLeft === 0) {
      room.questionLocked = true;
      stopTimer(room);
      sync(room);
      broadcast(room, 'question_timeout');
    }
  }, 250);
}
function nextQuestion(room) {
  if (room.questionNumber >= room.totalQuestions) {
    room.status = 'finished'; stopTimer(room); sync(room);
    broadcast(room, 'match_finished', {
      scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score }))
    });
    return;
  }
  room.questionNumber += 1;
  resetQuestion(room);
  broadcast(room, 'question_start', {
    questionNumber: room.questionNumber,
    totalQuestions: room.totalQuestions,
    timeLeft: room.timeLeft,
    token: room.questionToken
  });
  sync(room);
  startTimer(room);
}
function createRoom(ws, playerName) {
  const player = { id: id(), name: name(playerName), ws, score: 0 };
  const room = {
    code: code(), hostId: player.id, players: [player], status: 'waiting',
    rubric: null, questionNumber: 0, totalQuestions: QUESTIONS_PER_MATCH,
    timeLeft: 0, buzzedPlayer: null, answerPhase: false,
    questionLocked: false, questionToken: null, timer: null
  };
  rooms.set(room.code, room);
  ws.roomCode = room.code; ws.playerId = player.id;
  send(ws, 'room_created', { code: room.code, playerId: player.id });
  sync(room);
}
function joinRoom(ws, playerName, rawCode) {
  const room = rooms.get(String(rawCode || '').trim().toUpperCase());
  if (!room) return send(ws, 'error', { message: 'Salle introuvable.' });
  if (room.players.length >= MAX_PLAYERS) return send(ws, 'error', { message: 'La salle est complète : 2 joueurs maximum.' });
  if (room.status !== 'waiting') return send(ws, 'error', { message: 'La partie a déjà commencé.' });
  const player = { id: id(), name: name(playerName), ws, score: 0 };
  room.players.push(player);
  ws.roomCode = room.code; ws.playerId = player.id;
  send(ws, 'room_joined', { code: room.code, playerId: player.id });
  sync(room);
  if (room.players.length === 2) broadcast(room, 'match_ready', { message: 'Les deux joueurs sont prêts.' });
}
function startMatch(room, playerId, rubric) {
  if (playerId !== room.hostId) return send(find(room, playerId), 'error', { message: 'Seul le créateur peut lancer le duel.' });
  if (room.players.length !== 2) return send(find(room, playerId), 'error', { message: 'Il faut exactement 2 joueurs.' });
  room.rubric = String(rubric || '').slice(0, 100);
  room.status = 'playing'; room.questionNumber = 0;
  room.players.forEach(p => p.score = 0);
  sync(room); nextQuestion(room);
}
function find(room, playerId) { return room.players.find(p => p.id === playerId)?.ws; }
function buzz(room, playerId) {
  if (room.status !== 'playing' || room.questionLocked || room.answerPhase) return;
  const p = room.players.find(x => x.id === playerId);
  if (!p) return;
  room.buzzedPlayer = playerId;
  room.answerPhase = true;
  stopTimer(room);
  broadcast(room, 'buzz', { playerId, playerName: p.name, timeLeft: room.timeLeft });
  sync(room);
}
function answer(room, playerId, correct) {
  if (room.status !== 'playing' || room.questionLocked || !room.answerPhase || room.buzzedPlayer !== playerId) return;
  const p = room.players.find(x => x.id === playerId);
  if (!p) return;
  room.questionLocked = true; room.answerPhase = false;
  const points = Boolean(correct) ? Math.max(1, room.timeLeft) : 0;
  p.score += points;
  broadcast(room, 'answer_result', { playerId, correct: Boolean(correct), points, score: p.score });
  sync(room);
}
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, service: 'Libreville Quizz Online', rooms: rooms.size }));
  }
  res.writeHead(404); res.end('Not found');
});
const wss = new WebSocket.Server({ server, clientTracking: true, perMessageDeflate: true });
wss.on('connection', ws => {
  send(ws, 'connected', { message: 'Connexion Libreville Quizz réussie.' });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return send(ws, 'error', { message: 'JSON invalide.' }); }
    if (m.type === 'create_room') return createRoom(ws, m.name);
    if (m.type === 'join_room') return joinRoom(ws, m.name, m.code);
    const room = rooms.get(ws.roomCode);
    if (!room) return send(ws, 'error', { message: 'Vous n’êtes dans aucune salle.' });
    if (m.type === 'start_match') return startMatch(room, ws.playerId, m.rubric);
    if (m.type === 'buzz') return buzz(room, ws.playerId);
    if (m.type === 'answer') return answer(room, ws.playerId, m.correct);
    if (m.type === 'next_question') {
      if (ws.playerId !== room.hostId) return send(ws, 'error', { message: 'Seul le créateur peut continuer.' });
      if (!room.questionLocked) return send(ws, 'error', { message: 'La question n’est pas terminée.' });
      return nextQuestion(room);
    }
    if (m.type === 'ping_room') return send(ws, 'pong_room', { at: Date.now() });
    send(ws, 'error', { message: 'Commande inconnue.' });
  });
  ws.on('close', () => {
    const room = rooms.get(ws.roomCode); if (!room) return;
    room.players = room.players.filter(p => p.ws !== ws);
    if (!room.players.length) { stopTimer(room); rooms.delete(room.code); return; }
    if (room.hostId === ws.playerId) room.hostId = room.players[0].id;
    stopTimer(room);
    room.status = 'waiting'; room.questionLocked = true; room.answerPhase = false;
    broadcast(room, 'opponent_left', { message: 'L’autre joueur a quitté la partie.' });
    sync(room);
  });
});
server.listen(PORT, HOST, () => console.log(`Libreville Quizz server listening on ${HOST}:${PORT}`));
