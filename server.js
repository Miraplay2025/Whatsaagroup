const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const axios = require('axios');
const fileUpload = require('express-fileupload');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(fileUpload());

const BASE = __dirname;
const TEMP = path.join(BASE, 'temp');
const SESSIONS = path.join(BASE, 'sessions');

[TEMP, SESSIONS].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d));

let socketRef = null;

function log(msg, type = 'info') {
  console.log(msg);
  if (socketRef) socketRef.emit('log', { msg, type });
}

/* =========================
   ZIP VALIDATION (REAL)
========================= */
function isValidZip(file) {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(4);
  fs.readSync(fd, buffer, 0, 4, 0);
  fs.closeSync(fd);
  return buffer.toString('hex') === '504b0304';
}

/* =========================
   EXTRACT ZIP
========================= */
async function extract(zip, dest) {
  await fs.createReadStream(zip)
    .pipe(unzipper.Extract({ path: dest }))
    .promise();
}

/* =========================
   START WHATSAPP WITH VALIDATION
========================= */
function startWhatsApp(sessionPath) {
  log('🚀 Iniciando WhatsApp...');

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox']
    }
  });

  let validated = false;

  const timeout = setTimeout(() => {
    if (!validated) {
      log('❌ Sessão inválida ou expirada (timeout)', 'error');
      try { client.destroy(); } catch {}
    }
  }, 30000); // 30s

  client.on('ready', async () => {
    validated = true;
    clearTimeout(timeout);

    log('✅ Sessão VÁLIDA e conectada', 'success');

    const info = client.info;
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);

    const data = [];
    for (const g of groups) {
      await g.fetchParticipants();
      data.push({
        name: g.name,
        members: g.participants.length
      });
    }

    socketRef.emit('session-data', {
      name: info.pushname,
      number: info.wid.user,
      groups: data
    });
  });

  client.on('auth_failure', msg => {
    validated = true;
    clearTimeout(timeout);
    log('❌ Falha de autenticação: ' + msg, 'error');
  });

  client.on('disconnected', reason => {
    if (!validated) {
      clearTimeout(timeout);
      log('❌ Sessão desconectada antes da validação: ' + reason, 'error');
    } else {
      log('⚠️ Sessão desconectada: ' + reason, 'warn');
    }
  });

  client.on('change_state', state => {
    log('🔄 Estado WhatsApp: ' + state);
  });

  client.on('error', err => {
    clearTimeout(timeout);
    log('❌ Erro interno WhatsApp: ' + err.message, 'error');
  });

  client.initialize();
}

/* =========================
   RESTORE VIA URL
========================= */
app.post('/restore-url', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.sendStatus(400);

    const name = 'session_' + Date.now();
    const zipPath = path.join(TEMP, name + '.zip');
    const sessionPath = path.join(SESSIONS, name);

    log('🌐 Baixando ZIP...');

    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      maxRedirects: 5,
      timeout: 20000
    });

    const writer = fs.createWriteStream(zipPath);
    response.data.pipe(writer);

    writer.on('finish', async () => {
      if (!isValidZip(zipPath)) {
        log('❌ Arquivo baixado NÃO é ZIP válido', 'error');
        return;
      }

      fs.mkdirSync(sessionPath);
      log('📦 Extraindo sessão...');
      await extract(zipPath, sessionPath);

      startWhatsApp(sessionPath);
    });

    res.sendStatus(200);

  } catch (e) {
    log('❌ Erro ao baixar ZIP: ' + e.message, 'error');
    res.status(500).send();
  }
});

/* =========================
   UPLOAD ZIP
========================= */
app.post('/upload', async (req, res) => {
  try {
    if (!req.files?.zip) return res.sendStatus(400);

    const name = 'session_' + Date.now();
    const zipPath = path.join(TEMP, name + '.zip');
    const sessionPath = path.join(SESSIONS, name);

    await req.files.zip.mv(zipPath);
    log('📥 ZIP recebido');

    if (!isValidZip(zipPath)) {
      log('❌ Upload não é ZIP válido', 'error');
      return res.sendStatus(400);
    }

    fs.mkdirSync(sessionPath);
    log('📦 Extraindo sessão...');
    await extract(zipPath, sessionPath);

    startWhatsApp(sessionPath);
    res.sendStatus(200);

  } catch (e) {
    log('❌ Erro upload: ' + e.message, 'error');
    res.sendStatus(500);
  }
});

/* =========================
   SOCKET
========================= */
io.on('connection', socket => {
  socketRef = socket;
  log('🔌 Cliente conectado');
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () =>
  console.log('🚀 Servidor rodando na porta ' + PORT)
);
