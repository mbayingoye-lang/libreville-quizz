const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';

const rooms = new Map();

const MAX_PLAYERS = 2;
const QUESTIONS_PER_MATCH = 15;
const QUESTION_SECONDS = 20;

/* =========================================================
   OUTILS
========================================================= */

function code() {
  let c;

  do {
    c = crypto
      .randomBytes(3)
      .toString('hex')
      .toUpperCase();
  } while (rooms.has(c));

  return c;
}

function id() {
  return crypto.randomUUID();
}

function name(v) {
  return (
    String(v || 'Joueur')
      .trim()
      .slice(0, 30) || 'Joueur'
  );
}

function send(ws, type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type,
        ...data
      })
    );
  }
}

/* =========================================================
   ÉTAT D'UNE SALLE
========================================================= */

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
      id: p.id,
      name: p.name,
      score: p.score,
      connected:
        p.ws &&
        p.ws.readyState === WebSocket.OPEN
    }))
  };
}

function broadcast(room, type, data = {}) {
  room.players.forEach(player => {
    send(player.ws, type, data);
  });
}

function sync(room) {
  broadcast(room, 'room_state', {
    state: state(room)
  });
}

/* =========================================================
   TIMER
========================================================= */

function stopTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
  }

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
    if (
      !rooms.has(room.code) ||
      room.questionToken !== token ||
      room.questionLocked ||
      room.answerPhase
    ) {
      stopTimer(room);
      return;
    }

    room.timeLeft = Math.max(
      0,
      QUESTION_SECONDS -
        Math.floor((Date.now() - started) / 1000)
    );

    broadcast(room, 'timer', {
      timeLeft: room.timeLeft
    });

    if (room.timeLeft === 0) {
      room.questionLocked = true;

      stopTimer(room);

      sync(room);

      broadcast(room, 'question_timeout');
    }
  }, 250);
}

/* =========================================================
   QUESTIONS
========================================================= */

function nextQuestion(room) {
  if (room.questionNumber >= room.totalQuestions) {
    room.status = 'finished';

    stopTimer(room);

    sync(room);

    broadcast(room, 'match_finished', {
      scores: room.players.map(player => ({
        id: player.id,
        name: player.name,
        score: player.score
      }))
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

/* =========================================================
   CRÉATION D'UNE SALLE
========================================================= */

function createRoom(ws, playerName) {
  const player = {
    id: id(),
    name: name(playerName),
    ws,
    score: 0
  };

  const room = {
    code: code(),

    hostId: player.id,

    players: [player],

    status: 'waiting',

    rubric: null,

    questionNumber: 0,

    totalQuestions: QUESTIONS_PER_MATCH,

    timeLeft: 0,

    buzzedPlayer: null,

    answerPhase: false,

    questionLocked: false,

    questionToken: null,

    timer: null
  };

  rooms.set(room.code, room);

  ws.roomCode = room.code;
  ws.playerId = player.id;

  send(ws, 'room_created', {
    code: room.code,
    playerId: player.id
  });

  sync(room);
}

/* =========================================================
   REJOINDRE UNE SALLE
========================================================= */

function joinRoom(ws, playerName, rawCode) {
  const room = rooms.get(
    String(rawCode || '')
      .trim()
      .toUpperCase()
  );

  if (!room) {
    return send(ws, 'error', {
      message: 'Salle introuvable.'
    });
  }

  if (room.players.length >= MAX_PLAYERS) {
    return send(ws, 'error', {
      message:
        'La salle est complète : 2 joueurs maximum.'
    });
  }

  if (room.status !== 'waiting') {
    return send(ws, 'error', {
      message:
        'La partie a déjà commencé.'
    });
  }

  const player = {
    id: id(),
    name: name(playerName),
    ws,
    score: 0
  };

  room.players.push(player);

  ws.roomCode = room.code;
  ws.playerId = player.id;

  send(ws, 'room_joined', {
    code: room.code,
    playerId: player.id
  });

  sync(room);

  if (room.players.length === 2) {
    broadcast(room, 'match_ready', {
      message:
        'Les deux joueurs sont prêts.'
    });
  }
}

/* =========================================================
   TROUVER UN JOUEUR
========================================================= */

function find(room, playerId) {
  return room.players.find(
    player => player.id === playerId
  )?.ws;
}

/* =========================================================
   DÉMARRER UNE PARTIE
========================================================= */

function startMatch(room, playerId, rubric) {
  if (playerId !== room.hostId) {
    return send(find(room, playerId),
