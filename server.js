'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';

const MAX_PLAYERS = 2;
const QUESTIONS_PER_MATCH = 15;
const QUESTION_SECONDS = 20;

const PUBLIC_DIR = path.join(__dirname, 'public');
const HTML_FILE = path.join(PUBLIC_DIR, 'libreville-quizz.html');

const rooms = new Map();

/* =========================
   UTILITAIRES
========================= */

function generateId() {
  return crypto.randomUUID();
}

function generateRoomCode() {
  let code;

  do {
    code = crypto
      .randomBytes(3)
      .toString('hex')
      .toUpperCase();
  } while (rooms.has(code));

  return code;
}

function cleanName(value) {
  return String(value || 'Joueur')
    .trim()
    .slice(0, 30) || 'Joueur';
}

function send(ws, type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type,
      ...data
    }));
  }
}

function findPlayer(room, playerId) {
  return room.players.find(
    player => player.id === playerId
  );
}

function findSocket(room, playerId) {
  const player = findPlayer(room, playerId);
  return player ? player.ws : null;
}

/* =========================
   ÉTAT DE LA SALLE
========================= */

function getRoomState(room) {
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
    questionLocked: room.questionLocked,

    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      score: player.score,
      connected:
        player.ws.readyState === WebSocket.OPEN
    }))
  };
}

function broadcast(room, type, data = {}) {
  for (const player of room.players) {
    send(player.ws, type, data);
  }
}

function syncRoom(room) {
  broadcast(room, 'room_state', {
    state: getRoomState(room)
  });
}

/* =========================
   TIMER
========================= */

function stopTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function resetQuestion(room) {
  stopTimer(room);

  room.questionToken = generateId();
  room.timeLeft = QUESTION_SECONDS;

  room.buzzedPlayer = null;
  room.answerPhase = false;
  room.questionLocked = false;
}

function startTimer(room) {
  const token = room.questionToken;
  const startedAt = Date.now();

  stopTimer(room);

  room.timer = setInterval(() => {
    if (!rooms.has(room.code)) {
      stopTimer(room);
      return;
    }

    if (room.questionToken !== token) {
      stopTimer(room);
      return;
    }

    if (
      room.questionLocked ||
      room.answerPhase ||
      room.status !== 'playing'
    ) {
      stopTimer(room);
      return;
    }

    const elapsedSeconds = Math.floor(
      (Date.now() - startedAt) / 1000
    );

    room.timeLeft = Math.max(
      0,
      QUESTION_SECONDS - elapsedSeconds
    );

    broadcast(room, 'timer', {
      timeLeft: room.timeLeft
    });

    if (room.timeLeft <= 0) {
      room.timeLeft = 0;
      room.questionLocked = true;

      stopTimer(room);

      syncRoom(room);

      broadcast(room, 'question_timeout', {
        questionNumber: room.questionNumber
      });
    }
  }, 250);
}

/* =========================
   QUESTIONS
========================= */

function nextQuestion(room) {
  if (!rooms.has(room.code)) {
    return;
  }

  if (room.questionNumber >= room.totalQuestions) {
    room.status = 'finished';

    stopTimer(room);

    syncRoom(room);

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

  syncRoom(room);

  startTimer(room);
}

/* =========================
   CRÉATION DE SALLE
========================= */

function createRoom(ws, playerName) {
  const player = {
    id: generateId(),
    name: cleanName(playerName),
    ws,
    score: 0
  };

  const room = {
    code: generateRoomCode(),

    hostId: player.id,

    players: [
      player
    ],

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

  syncRoom(room);
}

/* =========================
   REJOINDRE UNE SALLE
========================= */

function joinRoom(ws, playerName, rawCode) {
  const roomCode = String(rawCode || '')
    .trim()
    .toUpperCase();

  const room = rooms.get(roomCode);

  if (!room) {
    send(ws, 'error', {
      message: 'Salle introuvable.'
    });
    return;
  }

  if (room.players.length >= MAX_PLAYERS) {
    send(ws, 'error', {
      message: 'La salle est complète : 2 joueurs maximum.'
    });
    return;
  }

  if (room.status !== 'waiting') {
    send(ws, 'error', {
      message: 'La partie a déjà commencé.'
    });
    return;
  }

  const player = {
    id: generateId(),
    name: cleanName(playerName),
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

  syncRoom(room);

  if (room.players.length === 2) {
    broadcast(room, 'match_ready', {
      message: 'Les deux joueurs sont prêts.'
    });
  }
}

/* =========================
   DÉMARRER LA PARTIE
========================= */

function startMatch(room, playerId, rubric) {
  if (playerId !== room.hostId) {
    send(
      findSocket(room, playerId),
      'error',
      {
        message:
          'Seul le créateur peut lancer le duel.'
      }
    );
    return;
  }

  if (room.players.length !== 2) {
    send(
      findSocket(room, playerId),
      'error',
      {
        message:
          'Il faut exactement 2 joueurs.'
      }
    );
    return;
  }

  room.rubric = String(rubric || '')
    .trim()
    .slice(0, 100);

  room.status = 'playing';

  room.questionNumber = 0;

  for (const player of room.players) {
    player.score = 0;
  }

  syncRoom(room);

  nextQuestion(room);
}

/* =========================
   BUZZER
========================= */

function buzz(room, playerId) {
  if (room.status !== 'playing') {
    return;
  }

  if (room.questionLocked) {
    return;
  }

  if (room.answerPhase) {
    return;
  }

  const player = findPlayer(room, playerId);

  if (!player) {
    return;
  }

  room.buzzedPlayer = playerId;
  room.answerPhase = true;

  stopTimer(room);

  broadcast(room, 'buzz', {
    playerId: player.id,
    playerName: player.name,
    timeLeft: room.timeLeft
  });

  syncRoom(room);
}

/* =========================
   RÉPONSE
========================= */

function answer(room, playerId, correct) {
  if (room.status !== 'playing') {
    return;
  }

  if (room.questionLocked) {
    return;
  }

  if (!room.answerPhase) {
    return;
  }

  if (room.buzzedPlayer !== playerId) {
    return;
  }

  const player = findPlayer(room, playerId);

  if (!player) {
    return;
  }

  const isCorrect = Boolean(correct);

  room.questionLocked = true;
  room.answerPhase = false;

  stopTimer(room);

  const points = isCorrect
    ? Math.max(1, room.timeLeft)
    : 0;

  player.score += points;

  broadcast(room, 'answer_result', {
    playerId: player.id,
    correct: isCorrect,
    points,
    score: player.score
  });

  syncRoom(room);
}

/* =========================
   SERVEUR HTTP
========================= */

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(500, {
        'Content-Type':
          'text/plain; charset=utf-8'
      });

      res.end(
        'Erreur serveur : fichier introuvable.'
      );

      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });

    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  const pathname = requestUrl.pathname;

  /* Page principale */
  if (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/libreville-quizz.html'
  ) {
    return serveFile(
      res,
      HTML_FILE,
      'text/html; charset=utf-8'
    );
  }

  /* Vérification Render */
  if (pathname === '/health') {
    res.writeHead(200, {
      'Content-Type':
        'application/json; charset=utf-8'
    });

    return res.end(
      JSON.stringify({
        ok: true,
        service: 'Libreville Quizz Online',
        rooms: rooms.size,
        players: Array.from(rooms.values())
          .reduce(
            (total, room) =>
              total + room.players.length,
            0
          )
      })
    );
  }

  /* Fichiers du dossier assets */
  if (pathname.startsWith('/assets/')) {
    const relativePath =
      pathname.replace('/assets/', '');

    const safePath = path.normalize(relativePath);

    if (
      safePath.startsWith('..') ||
      path.isAbsolute(safePath)
    ) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    const assetPath = path.join(
      PUBLIC_DIR,
      'assets',
      safePath
    );

    const extension =
      path.extname(assetPath).toLowerCase();

    const mimeTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.mp4': 'video/mp4'
    };

    return serveFile(
      res,
      assetPath,
      mimeTypes[extension] ||
        'application/octet-stream'
    );
  }

  /* Favicon */
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  res.writeHead(404, {
    'Content-Type':
      'text/plain; charset=utf-8'
  });

  res.end('Not found');
});

/* =========================
   WEBSOCKET
========================= */

const wss = new WebSocket.Server({
  server,
  clientTracking: true,
  perMessageDeflate: true
});

wss.on('connection', ws => {
  send(ws, 'connected', {
    message:
      'Connexion Libreville Quizz réussie.'
  });

  ws.on('message', raw => {
    let message;

    try {
      message = JSON.parse(
        raw.toString()
      );
    } catch (error) {
      send(ws, 'error', {
        message: 'JSON invalide.'
      });

      return;
    }

    /* Création d'une salle */
    if (message.type === 'create_room') {
      return createRoom(
        ws,
        message.name
      );
    }

    /* Rejoindre une salle */
    if (message.type === 'join_room') {
      return joinRoom(
        ws,
        message.name,
        message.code
      );
    }

    /* Toutes les autres commandes nécessitent une salle */
    const room = rooms.get(
      ws.roomCode
    );

    if (!room) {
      send(ws, 'error', {
        message:
          'Vous n’êtes dans aucune salle.'
      });

      return;
    }

    /* Démarrage */
    if (message.type === 'start_match') {
      return startMatch(
        room,
        ws.playerId,
        message.rubric
      );
    }

    /* Buzzer */
    if (message.type === 'buzz') {
      return buzz(
        room,
        ws.playerId
      );
    }

    /* Réponse */
    if (message.type === 'answer') {
      return answer(
        room,
        ws.playerId,
        message.correct
      );
    }

    /* Question suivante */
    if (
      message.type ===
      'next_question'
    ) {
      if (
        ws.playerId !== room.hostId
      ) {
        send(ws, 'error', {
          message:
            'Seul le créateur peut continuer.'
        });

        return;
      }

      if (!room.questionLocked) {
        send(ws, 'error', {
          message:
            'La question n’est pas terminée.'
        });

        return;
      }

      return nextQuestion(room);
    }

    /* Ping */
    if (
      message.type ===
      'ping_room'
    ) {
      send(ws, 'pong_room', {
        at: Date.now()
      });

      return;
    }

    /* Commande inconnue */
    send(ws, 'error', {
      message:
        'Commande inconnue.'
    });
  });

  /* Déconnexion */
  ws.on('close', () => {
    const room = rooms.get(
      ws.roomCode
    );

    if (!room) {
      return;
    }

    room.players =
      room.players.filter(
        player =>
          player.ws !== ws
      );

    /* Plus aucun joueur */
    if (room.players.length === 0) {
      stopTimer(room);
      rooms.delete(room.code);
      return;
    }

    /* Le créateur quitte */
    if (
      room.hostId ===
      ws.playerId
    ) {
      room.hostId =
        room.players[0].id;
    }

    stopTimer(room);

    room.status = 'waiting';
    room.questionLocked = true;
    room.answerPhase = false;
    room.buzzedPlayer = null;

    broadcast(
      room,
      'opponent_left',
      {
        message:
          'L’autre joueur a quitté la partie.'
      }
    );

    syncRoom(room);
  });
});

/* =========================
   ARRÊT PROPRE
========================= */

function shutdown() {
  console.log(
    'Arrêt du serveur...'
  );

  for (const room of rooms.values()) {
    stopTimer(room);
  }

  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
}

process.on(
  'SIGTERM',
  shutdown
);

process.on(
  'SIGINT',
  shutdown
);

/* =========================
   DÉMARRAGE
========================= */

server.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `Libreville Quizz server listening on ${HOST}:${PORT}`
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `HTML: ${HTML_FILE}`
    );
  }
);
