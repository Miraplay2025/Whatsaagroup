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
   LOG CENTRAL
========================= */
function log(socket, msg) {
  console.log(msg);
  socket.emit('log', msg);
}

/* =========================
   VALIDAR ZIP DE SESSÃO
========================= */
function validateZipSession(zipPath) {
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries().map(e => e.entryName);
    // estrutura mínima esperada do whatsapp-web.js
    return entries.some(e => e.includes('.wwebjs_auth'));
  } catch {
    return false;
  }
}

/* =========================
   UPLOAD + EXTRAÇÃO DO ZIP
========================= */
app.post('/upload', upload.single('zip'), (req, res) => {
  if (!req.file) {
    return res.json({ success: false, error: 'ZIP não enviado' });
  }

  if (!validateZipSession(req.file.path)) {
    fs.unlinkSync(req.file.path);
    return res.json({
      success: false,
      error: 'ZIP inválido (sessão WhatsApp não encontrada)'
    });
  }

  const authDir = path.join(__dirname, '.wwebjs_auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir);

  try {
    const zip = new AdmZip(req.file.path);
    zip.extractAllTo(authDir, true);
    fs.unlinkSync(req.file.path);

    return res.json({ success: true });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
});

/* =========================
   INICIAR WHATSAPP
========================= */
function startSession(socket) {
  if (clientInstance) {
    log(socket, '⚠️ WhatsApp já está conectado');
    return;
  }

  log(socket, '🚀 Iniciando conexão com WhatsApp...');

  clientInstance = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    }
  });

  clientInstance.on('ready', async () => {
    log(socket, '✅ WhatsApp conectado com sucesso');

    const info = clientInstance.info;
    log(socket, `👤 Conta: ${info.pushname} (${info.me.user})`);

    let chats = [];
    try {
      chats = await clientInstance.getChats();
    } catch {
      log(socket, '⚠️ Erro ao buscar chats');
    }

    const groups = chats.filter(c => c.isGroup);
    log(socket, `📦 Grupos encontrados: ${groups.length}`);

    socket.emit('session-info', {
      name: info.pushname,
      number: info.me.user,
      groups: groups.map(g => ({
        name: g.name,
        members: g.participants?.length || 0
      }))
    });
  });

  clientInstance.on('auth_failure', () => {
    log(socket, '❌ Falha de autenticação (ZIP inválido ou sessão expirada)');
    clientInstance = null;
  });

  clientInstance.on('disconnected', reason => {
    log(socket, `❌ WhatsApp desconectado: ${reason}`);
    clientInstance = null;
  });

  clientInstance.initialize();
}

/* =========================
   SOCKET.IO
========================= */
io.on('connection', socket => {

  socket.on('connect-whatsapp', () => {
    startSession(socket);
  });

  socket.on('send-message', async data => {
    if (!clientInstance) {
      log(socket, '❌ WhatsApp não está conectado');
      return;
    }

    if (!data.number || !data.message) {
      log(socket, '❌ Número ou mensagem inválidos');
      return;
    }

    const numberId = data.number.replace(/\D/g, '') + '@c.us';
    log(socket, `📨 Enviando mensagem para ${data.number}...`);

    try {
      await clientInstance.sendMessage(numberId, data.message);
      log(socket, '✅ Mensagem enviada com sucesso');
    } catch (e) {
      log(socket, '❌ Erro ao enviar mensagem');
    }
  });

});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`);
});
