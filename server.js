const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const upload = multer({ dest: 'uploads/' });
let clientInstance = null;

/* =========================
   UTIL: LOG
========================= */
function log(socket, msg){
  console.log(msg);
  socket.emit('log', msg);
}

/* =========================
   VALIDATE ZIP
========================= */
function validateZipSession(zipPath){
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries().map(e => e.entryName);
    // valida estrutura mínima do whatsapp-web.js
    return entries.some(e => e.includes('.wwebjs_auth'));
  } catch {
    return false;
  }
}

/* =========================
   UPLOAD ZIP
========================= */
app.post('/upload', upload.single('zip'), (req, res) => {
  if (!req.file) {
    return res.json({ success:false, error:'ZIP não enviado' });
  }

  const valid = validateZipSession(req.file.path);
  if (!valid) {
    fs.unlinkSync(req.file.path);
    return res.json({ success:false, error:'ZIP inválido (sessão não encontrada)' });
  }

  const authDir = path.join(__dirname, '.wwebjs_auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir);

  const zip = new AdmZip(req.file.path);
  zip.extractAllTo(authDir, true);
  fs.unlinkSync(req.file.path);

  res.json({ success:true });
});

/* =========================
   START SESSION
========================= */
function startSession(socket){
  if (clientInstance) {
    log(socket,'⚠️ Sessão já ativa');
    return;
  }

  log(socket,'🚀 Iniciando conexão com WhatsApp...');

  clientInstance = new Client({
    authStrategy: new LocalAuth(),
    puppeteer:{
      headless:true,
      args:['--no-sandbox','--disable-setuid-sandbox']
    }
  });

  clientInstance.on('ready', async () => {
    log(socket,'✅ WhatsApp conectado');

    const info = clientInstance.info;
    log(socket,`👤 Conta: ${info.pushname} (${info.me.user})`);

    const chats = await clientInstance.getChats();
    const groups = chats.filter(c => c.isGroup);

    log(socket,`📦 Grupos encontrados: ${groups.length}`);

    socket.emit('session-info',{
      name: info.pushname,
      number: info.me.user,
      groups: groups.map(g => ({
        name: g.name,
        members: g.participants?.length || 0
      }))
    });
  });

  clientInstance.on('auth_failure', () => {
    log(socket,'❌ Falha de autenticação');
  });

  clientInstance.initialize();
}

/* =========================
   SEND MESSAGE
========================= */
io.on('connection', socket => {

  socket.on('connect-whatsapp', () => {
    startSession(socket);
  });

  socket.on('send-message', async data => {
    if (!clientInstance) {
      log(socket,'❌ WhatsApp não conectado');
      return;
    }

    const number = data.number.replace(/\D/g,'') + '@c.us';
    log(socket,`📨 Enviando mensagem para ${data.number}...`);

    try {
      await clientInstance.sendMessage(number, data.message);
      log(socket,'✅ Mensagem enviada com sucesso');
    } catch (e) {
      log(socket,'❌ Erro ao enviar mensagem');
    }
  });

});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log(`🌐 Servidor rodando na porta ${PORT}`)
);
