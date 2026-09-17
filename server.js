const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
const MAX_PLAYERS = 4;
const rooms = new Map();
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-5.6-luna").trim();
const AI_WEB_SEARCH = /^(1|true|yes)$/i.test(String(process.env.AI_WEB_SEARCH || ""));

const RUBRIC_LABELS = {
  gabon:"Gabon", afrique:"Afrique", culture:"Culture Noire", leaders:"Leaders Noirs",
  gabon_afrique:"Gabon & l’Afrique", gabon_monde:"Gabon & le Monde",
  provinces_tourisme:"Gabon : 9 provinces & tourisme",
  architecture_civilisations:"Architecture traditionnelle d’Afrique"
};

function cleanName(name) { return String(name || "Joueur").replace(/[<>]/g, "").trim().slice(0, 24) || "Joueur"; }
function makeCode() { const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let code=""; do { code=""; for(let i=0;i<6;i++) code+=chars[crypto.randomInt(chars.length)]; } while(rooms.has(code)); return code; }
function send(ws,obj){ if(ws&&ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function roomView(room){ return {code:room.code,hostId:room.hostId,status:room.status,rubric:room.rubric||null,ai:!!room.ai,players:[...room.players.values()].map(p=>({id:p.id,name:p.name,score:p.score,ready:p.ready}))}; }
function broadcast(room,obj){ for(const p of room.players.values()) send(p.ws,obj); }
function broadcastRoom(room){ broadcast(room,{type:"room_state",room:roomView(room)}); }
function validQuestion(q){ return q&&typeof q.q==="string"&&q.q.trim().length>=10&&Array.isArray(q.choices)&&q.choices.length===4&&q.choices.every(x=>typeof x==="string"&&x.trim())&&Number.isInteger(q.correct)&&q.correct>=0&&q.correct<4; }
function clearGameTimer(room){ if(room.timer) clearTimeout(room.timer); room.timer=null; }
function sanitizeQuestion(q){ return {q:String(q.q).trim().slice(0,300),choices:q.choices.map(x=>String(x).trim().slice(0,160)),correct:Number(q.correct),dyn:String(q.dyn||q.explanation||"").trim().slice(0,300),difficulty:Math.max(1,Math.min(3,Number(q.difficulty)||2))}; }

async function generateAIQuestions(rubric, count){
  if(!OPENAI_API_KEY) throw new Error("Agent IA non configuré : ajoutez OPENAI_API_KEY dans les variables d’environnement Render.");
  const label=RUBRIC_LABELS[rubric]||rubric;
  const schema={type:"object",additionalProperties:false,properties:{questions:{type:"array",items:{type:"object",additionalProperties:false,properties:{q:{type:"string"},choices:{type:"array",items:{type:"string"},minItems:4,maxItems:4},correct:{type:"integer",minimum:0,maximum:3},dyn:{type:"string"},difficulty:{type:"integer",minimum:1,maximum:3}},required:["q","choices","correct","dyn","difficulty"]},minItems:count,maxItems:count}},required:["questions"]};
  const prompt=`Génère exactement ${count} questions originales pour un quiz multijoueur francophone. Rubrique : ${label}. Priorité au Gabon, à l'Afrique et à la diaspora noire lorsque cela correspond à la rubrique.\n\nRègles : chaque question doit avoir exactement 4 réponses, une seule bonne réponse, un index correct de 0 à 3, une explication factuelle courte, et une difficulté 1 facile, 2 moyenne ou 3 difficile. Évite les doublons, les ambiguïtés, les affirmations incertaines et les sujets politiques contemporains controversés. N'inclus aucune réponse dans l'énoncé. Retourne uniquement le JSON conforme au schéma.`;
  const body={model:OPENAI_MODEL,input:prompt,text:{format:{type:"json_schema",name:"libreville_quizz_questions",strict:true,schema}},store:false};
  if(AI_WEB_SEARCH) body.tools=[{type:"web_search"}];
  const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${OPENAI_API_KEY}`},body:JSON.stringify(body)});
  if(!r.ok){const t=await r.text();throw new Error(`OpenAI ${r.status}: ${t.slice(0,500)}`);}
  const data=await r.json();
  const text=data.output_text||((data.output||[]).flatMap(x=>x.content||[]).find(x=>x.type==="output_text")||{}).text;
  if(!text) throw new Error("Réponse IA vide.");
  let parsed; try{parsed=JSON.parse(text);}catch{throw new Error("La réponse de l’agent IA n’est pas un JSON valide.");}
  const qs=Array.isArray(parsed.questions)?parsed.questions.map(sanitizeQuestion).filter(validQuestion):[];
  if(qs.length<count) throw new Error(`L’agent IA n’a fourni que ${qs.length}/${count} questions valides.`);
  return qs.slice(0,count);
}

function finishQuestion(room,timeout=false){
  if(!room||room.status!=="playing"||room.resultSent)return;
  room.resultSent=true;clearGameTimer(room);const q=room.questions[room.questionIndex];const players=[...room.players.values()];
  for(const p of players){const choice=room.answers.get(p.id);p.lastAnswer=choice===undefined?null:choice;if(!timeout&&choice===q.correct)p.score+=10;}
  const answerText=String(q.choices[q.correct]??"");const correctPlayers=players.filter(p=>p.lastAnswer===q.correct);const names=correctPlayers.map(p=>p.name);const publicPlayers=players.map(p=>({id:p.id,name:p.name,score:p.score}));
  for(const p of players){const ownChoice=p.lastAnswer;send(p.ws,{type:"question_result",correct:ownChoice===q.correct,answerText,timeout:!!timeout,players:publicPlayers,message:ownChoice===q.correct?"✅ Bonne réponse : +10 points.":(ownChoice===null?"⏱️ Aucune réponse envoyée.":(names.length?`❌ Réponse incorrecte. ${names.join(", ")} ont trouvé la bonne réponse.`:"❌ Aucun joueur n'a trouvé la bonne réponse."))});}
  setTimeout(()=>nextQuestion(room),3500);
}
function nextQuestion(room){
  if(!room||room.status!=="playing")return;room.questionIndex++;if(room.questionIndex>=room.questions.length){room.status="finished";clearGameTimer(room);const players=[...room.players.values()].map(p=>({id:p.id,name:p.name,score:p.score})).sort((a,b)=>b.score-a.score);broadcast(room,{type:"game_over",players});return;}
  room.answers=new Map();room.resultSent=false;const q=room.questions[room.questionIndex];room.roundSeconds=Math.max(10,Math.min(60,Number(room.seconds)||20));room.endsAt=Date.now()+room.roundSeconds*1000;
  broadcast(room,{type:"next_question",room:roomView(room),question:{q:q.q,choices:q.choices,dyn:q.dyn||"",difficulty:q.difficulty||1},index:room.questionIndex,total:room.questions.length,endsAt:room.endsAt});
  room.timer=setTimeout(()=>finishQuestion(room,true),room.roundSeconds*1000+150);
}

async function startGame(room,host,msg){
  if(room.hostId!==host.id)return send(host.ws,{type:"error",message:"Seul l'hôte peut lancer la partie."});
  if(room.players.size<2)return send(host.ws,{type:"error",message:"Il faut au moins 2 joueurs pour commencer."});
  if(room.status!=="waiting")return send(host.ws,{type:"error",message:"La partie a déjà commencé."});
  const rounds=Math.min(20,Math.max(10,Number(msg.rounds)||10));
  room.seconds=Math.max(10,Math.min(60,Number(msg.seconds)||20));room.rubric=String(msg.rubric||"gabon").slice(0,60);room.ai=!!msg.ai;
  let questions=[];
  try{
    if(room.ai){
      if(!OPENAI_API_KEY)return send(host.ws,{type:"error",message:"🤖 Agent IA indisponible. Configurez OPENAI_API_KEY sur Render ou désactivez Agent IA."});
      room.status="generating";broadcastRoom(room);broadcast(room,{type:"ai_generating",rubric:room.rubric,rounds});
      questions=await generateAIQuestions(room.rubric,rounds);
    }else{
      questions=Array.isArray(msg.questions)?msg.questions.filter(validQuestion).slice(0,20).map(sanitizeQuestion):[];
      if(questions.length<rounds)return send(host.ws,{type:"error",message:`La partie doit contenir au moins ${rounds} questions valides.`});
      questions=questions.slice(0,rounds);
    }
  }catch(err){ room.status="waiting";broadcastRoom(room);return send(host.ws,{type:"error",message:"🤖 Génération des questions impossible : "+String(err.message||err).slice(0,600)}); }
  if(questions.length<10){room.status="waiting";broadcastRoom(room);return send(host.ws,{type:"error",message:"Pas assez de questions valides pour démarrer."});}
  room.questions=questions;room.status="playing";room.questionIndex=0;room.answers=new Map();room.resultSent=false;for(const p of room.players.values()){p.score=0;p.ready=true;}
  const q=room.questions[0];room.endsAt=Date.now()+room.seconds*1000;
  broadcast(room,{type:"game_start",room:roomView(room),question:{q:q.q,choices:q.choices,dyn:q.dyn||"",difficulty:q.difficulty||1},index:0,total:room.questions.length,endsAt:room.endsAt});
  room.timer=setTimeout(()=>finishQuestion(room,true),room.seconds*1000+150);
}
function removePlayer(room,id,ws){if(!room)return;const p=room.players.get(id);if(!p||p.ws!==ws)return;room.players.delete(id);room.answers.delete(id);if(room.players.size===0){clearGameTimer(room);rooms.delete(room.code);return;}if(room.hostId===id)room.hostId=room.players.values().next().value.id;broadcast(room,{type:"player_left",name:p.name,room:roomView(room)});if(room.status!=="playing")broadcastRoom(room);}

const server=http.createServer((req,res)=>{if(req.url==="/health"){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:true,service:"Libreville Quizz Online",rooms:rooms.size,ai:!!OPENAI_API_KEY,model:OPENAI_MODEL}));}if(req.url==="/"||req.url==="/libreville-quizz.html"){const file=path.join(__dirname,"libreville-quizz.html");res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});return fs.createReadStream(file).pipe(res);}res.writeHead(404,{"Content-Type":"text/plain; charset=utf-8"});res.end("Not found");});
const wss=new WebSocket.Server({server});
wss.on("connection",ws=>{let room=null;let playerId=null;ws.on("message",async raw=>{let msg;try{msg=JSON.parse(raw.toString())}catch{return send(ws,{type:"error",message:"Message invalide."});}
  if(msg.type==="create_room"){if(room)return;const code=makeCode(),id=crypto.randomUUID();room={code,hostId:id,status:"waiting",rubric:null,ai:false,players:new Map(),questions:[],questionIndex:0,seconds:20,endsAt:0,answers:new Map(),timer:null,resultSent:false};playerId=id;room.players.set(id,{id,name:cleanName(msg.name),ws,score:0,ready:false});rooms.set(code,room);return send(ws,{type:"room_created",room:roomView(room),playerId:id,isHost:true});}
  if(msg.type==="join_room"){if(room)return;const code=String(msg.roomCode||"").toUpperCase().trim(),target=rooms.get(code);if(!target)return send(ws,{type:"error",message:"Salon introuvable. Vérifiez le code."});if(target.status!=="waiting")return send(ws,{type:"error",message:"Cette partie a déjà commencé."});if(target.players.size>=MAX_PLAYERS)return send(ws,{type:"error",message:"Salon complet (4 joueurs maximum)."});const id=crypto.randomUUID();room=target;playerId=id;room.players.set(id,{id,name:cleanName(msg.name),ws,score:0,ready:false});send(ws,{type:"room_joined",room:roomView(room),playerId:id,isHost:false});return broadcastRoom(room);}
  if(!room||!playerId)return send(ws,{type:"error",message:"Rejoignez ou créez un salon d'abord."});const me=room.players.get(playerId);if(!me)return;
  if(msg.type==="start_game")return startGame(room,me,msg);
  if(msg.type==="answer"){if(room.status!=="playing"||room.resultSent)return;if(Date.now()>room.endsAt+50)return;if(room.answers.has(playerId))return;const q=room.questions[room.questionIndex],choice=Number(msg.choiceIndex);if(!Number.isInteger(choice)||choice<0||choice>3)return;room.answers.set(playerId,choice);send(ws,{type:"answer_received"});if(room.answers.size>=room.players.size)finishQuestion(room,false);return;}
  if(msg.type==="leave_room"){removePlayer(room,playerId,ws);room=null;playerId=null;try{ws.close()}catch{}}
});ws.on("close",()=>{if(room&&playerId)removePlayer(room,playerId,ws);});});
server.listen(PORT,HOST,()=>console.log(`Libreville Quizz Online server listening on ${HOST}:${PORT} | AI=${!!OPENAI_API_KEY} model=${OPENAI_MODEL}`));
