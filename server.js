const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const MAX_PLAYERS = 4;
const rooms = new Map();

const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-5.6-luna').trim();
const AI_WEB_SEARCH = /^(1|true|yes)$/i.test(String(process.env.AI_WEB_SEARCH || ''));

const RUBRICS = {
  gabon: 'Gabon',
  afrique: 'Afrique',
  culture: 'Culture Noire',
  leaders: 'Leaders Noirs',
  gabon_afrique: "Gabon & l'Afrique",
  gabon_monde: 'Gabon & le Monde',
  provinces_tourisme: 'Gabon : 9 provinces & tourisme',
  architecture_civilisations: "Architecture traditionnelle d'Afrique"
};

function cleanName(name) {
  return String(name || 'Joueur').replace(/[<>]/g, '').trim().slice(0, 24) || 'Joueur';
}
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  } while (rooms.has(code));
  return code;
}
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj) {
  for (const p of room.players.values()) send(p.ws, obj);
}
function roomView(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    rubric: room.rubric || null,
    ai: !!room.ai,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, score: p.score, ready: p.ready
    }))
  };
}
function broadcastRoom(room) {
  broadcast(room, { type: 'room_state', room: roomView(room) });
}
function validQuestion(q) {
  return q && typeof q.q === 'string' && q.q.trim().length >= 10 &&
    Array.isArray(q.choices) && q.choices.length === 4 &&
    q.choices.every(x => typeof x === 'string' && x.trim()) &&
    Number.isInteger(q.correct) && q.correct >= 0 && q.correct < 4;
}
function sanitizeQuestion(q) {
  return {
    q: String(q.q).trim().slice(0, 300),
    choices: q.choices.map(x => String(x).trim().slice(0, 160)),
    correct: Number(q.correct),
    dyn: String(q.dyn || q.explanation || '').trim().slice(0, 300),
    difficulty: Math.max(1, Math.min(3, Number(q.difficulty) || 2))
  };
}
function publicQuestion(q) {
  // IMPORTANT: never send the correct index to clients.
  return { q: q.q, choices: q.choices, dyn: q.dyn || '', difficulty: q.difficulty || 2 };
}
function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

async function generateAIQuestions(rubric, count) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY est absente des variables Render.');
  const label = RUBRICS[rubric] || String(rubric || 'Culture générale');

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      questions: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string' },
            choices: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'string' } },
            correct: { type: 'integer', minimum: 0, maximum: 3 },
            dyn: { type: 'string' },
            difficulty: { type: 'integer', minimum: 1, maximum: 3 }
          },
          required: ['q', 'choices', 'correct', 'dyn', 'difficulty']
        }
      }
    },
    required: ['questions']
  };

  const prompt = `Génère exactement ${count} questions originales en français pour Libreville Quizz.
Rubrique : ${label}.
Priorité au Gabon et à l'Afrique quand c'est pertinent.
Chaque question doit avoir exactement 4 réponses, une seule bonne réponse, correct = index 0 à 3, une explication factuelle courte et difficulté 1 à 3.
Évite les doublons, ambiguïtés, informations douteuses et sujets politiques contemporains controversés.
Retourne uniquement le JSON conforme au schéma.`;

  const body = {
    model: OPENAI_MODEL,
    input: prompt,
    store: false,
    text: {
      format: {
        type: 'json_schema',
        name: 'libreville_quizz_questions',
        strict: true,
        schema
      }
    }
  };
  if (AI_WEB_SEARCH) body.tools = [{ type: 'web_search' }];

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${raw.slice(0, 700)}`);

  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('Réponse OpenAI invalide.'); }
  const text = data.output_text || ((data.output || []).flatMap(x => x.content || []).find(x => x.type === 'output_text') || {}).text;
  if (!text) throw new Error('Réponse IA vide.');

  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('La réponse IA n’est pas un JSON valide.'); }
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.map(sanitizeQuestion).filter(validQuestion)
    : [];
  if (questions.length < count) throw new Error(`Questions valides reçues : ${questions.length}/${count}.`);
  return questions.slice(0, count);
}

function finishQuestion(room, timeout = false) {
  if (!room || room.status !== 'playing' || room.resultSent) return;
  room.resultSent = true;
  clearTimer(room);
  const q = room.questions[room.questionIndex];
  const players = [...room.players.values()];

  for (const p of players) {
    const choice = room.answers.get(p.id);
    p.lastAnswer = choice === undefined ? null : choice;
    if (!timeout && choice === q.correct) p.score += 10;
  }

  const answerText = q.choices[q.correct] || '';
  const correctNames = players.filter(p => p.lastAnswer === q.correct).map(p => p.name);
  const publicPlayers = players.map(p => ({ id: p.id, name: p.name, score: p.score }));

  for (const p of players) {
    const ownChoice = p.lastAnswer;
    send(p.ws, {
      type: 'question_result',
      correct: ownChoice === q.correct,
      answerText,
      timeout: !!timeout,
      players: publicPlayers,
      message: ownChoice === q.correct
        ? '✅ Bonne réponse : +10 points.'
        : ownChoice === null
          ? '⏱️ Aucune réponse envoyée.'
          : correctNames.length
            ? `❌ Réponse incorrecte. ${correctNames.join(', ')} ont trouvé la bonne réponse.`
            : '❌ Aucun joueur n’a trouvé la bonne réponse.'
    });
  }

  room.timer = setTimeout(() => nextQuestion(room), 3500);
}

function nextQuestion(room) {
  if (!room || room.status !== 'playing') return;
  room.questionIndex++;
  if (room.questionIndex >= room.questions.length) {
    room.status = 'finished';
    clearTimer(room);
    const players = [...room.players.values()]
      .map(p => ({ id: p.id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
    broadcast(room, { type: 'game_over', players });
    return;
  }
  room.answers.clear();
  room.resultSent = false;
  const q = room.questions[room.questionIndex];
  room.endsAt = Date.now() + room.seconds * 1000;
  broadcast(room, {
    type: 'next_question',
    room: roomView(room),
    question: publicQuestion(q),
    index: room.questionIndex,
    total: room.questions.length,
    endsAt: room.endsAt
  });
  room.timer = setTimeout(() => finishQuestion(room, true), room.seconds * 1000 + 150);
}

async function startGame(room, host, msg) {
  if (room.hostId !== host.id) return send(host.ws, { type: 'error', message: 'Seul l’hôte peut lancer la partie.' });
  if (room.players.size < 2) return send(host.ws, { type: 'error', message: 'Il faut au moins 2 joueurs.' });
  if (room.status !== 'waiting') return send(host.ws, { type: 'error', message: 'La partie a déjà commencé.' });

  const rounds = Math.min(20, Math.max(10, Number(msg.rounds) || 10));
  room.seconds = Math.min(60, Math.max(10, Number(msg.seconds) || 20));
  room.rubric = String(msg.rubric || 'gabon').slice(0, 60);
  room.ai = !!msg.ai;

  try {
    room.status = 'generating';
    broadcastRoom(room);
    let questions;

    if (room.ai) {
      broadcast(room, { type: 'ai_generating', rubric: room.rubric, rounds });
      questions = await generateAIQuestions(room.rubric, rounds);
    } else {
      questions = Array.isArray(msg.questions)
        ? msg.questions.filter(validQuestion).map(sanitizeQuestion).slice(0, rounds)
        : [];
      if (questions.length < rounds) throw new Error(`Il faut ${rounds} questions valides en mode banque locale.`);
    }

    room.questions = questions;
    room.status = 'playing';
    room.questionIndex = 0;
    room.answers.clear();
    room.resultSent = false;
    for (const p of room.players.values()) { p.score = 0; p.ready = true; p.lastAnswer = null; }

    const q = room.questions[0];
    room.endsAt = Date.now() + room.seconds * 1000;
    broadcast(room, {
      type: 'game_start',
      room: roomView(room),
      question: publicQuestion(q),
      index: 0,
      total: room.questions.length,
      endsAt: room.endsAt
    });
    room.timer = setTimeout(() => finishQuestion(room, true), room.seconds * 1000 + 150);
  } catch (err) {
    room.status = 'waiting';
    room.questions = [];
    clearTimer(room);
    broadcastRoom(room);
    send(host.ws, { type: 'error', message: `🤖 ${String(err.message || err).slice(0, 800)}` });
  }
}

function removePlayer(room, id, ws) {
  if (!room) return;
  const p = room.players.get(id);
  if (!p || p.ws !== ws) return;
  room.players.delete(id);
  room.answers.delete(id);

  if (room.players.size === 0) {
    clearTimer(room);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === id) room.hostId = room.players.values().next().value.id;
  broadcastRoom(room);
  broadcast(room, { type: 'player_left', name: p.name, room: roomView(room) });
}

const publicDir = path.join(__dirname, 'public');
const indexFile = path.join(publicDir, 'libreville-quizz.html');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true,
      service: 'Libreville Quizz Online',
      rooms: rooms.size,
      ai: !!OPENAI_API_KEY,
      model: OPENAI_MODEL,
      webSearch: AI_WEB_SEARCH
    }));
  }

  if (url.pathname === '/' || url.pathname === '/libreville-quizz.html') {
    if (!fs.existsSync(indexFile)) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Fichier public/libreville-quizz.html introuvable.');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(indexFile).pipe(res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  let room = null;
  let playerId = null;

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return send(ws, { type: 'error', message: 'Message JSON invalide.' }); }

    if (msg.type === 'ping') return send(ws, { type: 'pong' });

    if (msg.type === 'create_room') {
      if (room) return;
      const code = makeCode();
      const id = crypto.randomUUID();
      room = {
        code, hostId: id, status: 'waiting', rubric: null, ai: false,
        players: new Map(), questions: [], questionIndex: 0, seconds: 20,
        endsAt: 0, answers: new Map(), timer: null, resultSent: false
      };
      playerId = id;
      room.players.set(id, { id, name: cleanName(msg.name), ws, score: 0, ready: false, lastAnswer: null });
      rooms.set(code, room);
      return send(ws, { type: 'room_created', room: roomView(room), playerId: id, isHost: true });
    }

    if (msg.type === 'join_room') {
      if (room) return;
      const code = String(msg.roomCode || '').toUpperCase().trim();
      const target = rooms.get(code);
      if (!target) return send(ws, { type: 'error', message: 'Salon introuvable. Vérifiez le code.' });
      if (target.status !== 'waiting') return send(ws, { type: 'error', message: 'Cette partie a déjà commencé.' });
      if (target.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'Salon complet (4 joueurs maximum).' });
      const id = crypto.randomUUID();
      room = target;
      playerId = id;
      room.players.set(id, { id, name: cleanName(msg.name), ws, score: 0, ready: false, lastAnswer: null });
      send(ws, { type: 'room_joined', room: roomView(room), playerId: id, isHost: false });
      return broadcastRoom(room);
    }

    if (!room || !playerId) return send(ws, { type: 'error', message: 'Créez ou rejoignez un salon.' });
    const me = room.players.get(playerId);
    if (!me) return;

    if (msg.type === 'start_game') return startGame(room, me, msg);

    if (msg.type === 'answer') {
      if (room.status !== 'playing' || room.resultSent) return;
      if (Date.now() > room.endsAt + 50) return;
      if (room.answers.has(playerId)) return;
      const choice = Number(msg.choiceIndex);
      if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;
      room.answers.set(playerId, choice);
      send(ws, { type: 'answer_received' });
      if (room.answers.size >= room.players.size) finishQuestion(room, false);
      return;
    }

    if (msg.type === 'leave_room') {
      removePlayer(room, playerId, ws);
      room = null;
      playerId = null;
      try { ws.close(); } catch {}
    }
  });

  ws.on('close', () => {
    if (room && playerId) removePlayer(room, playerId, ws);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Libreville Quizz Online: http://${HOST}:${PORT}`);
  console.log(`AI=${!!OPENAI_API_KEY} MODEL=${OPENAI_MODEL} WEB_SEARCH=${AI_WEB_SEARCH}`);
});
