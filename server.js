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

function log(msg, type='info') {
  console.log(msg);
  if (socketRef) socketRef.emit('log', { msg, type });
}

/* =========================
   VALIDAR ZIP REAL
========================= */
function isValidZip(file) {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(4);
  fs.readSync(fd, buffer, 0, 4, 0);
  fs.closeSync(fd);
  return buffer.toString('hex') === '504b0304';
}

/* =========================
   EXTRAIR ZIP
========================= */
async function extract(zip, dest) {
  await fs.createReadStream(zip)
    .pipe(unzipper.Extract({ path: dest }))
    .promise();
}

/* =========================
   INICIAR WHATSAPP
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

  client.on('ready', async () => {
    log('✅ Sessão válida e conectada', 'success');

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

  client.on('auth_failure', () => {
    log('❌ Sessão inválida ou expirada', 'error');
  });

  client.on('disconnected', r => {
    log('⚠️ Sessão desconectada: ' + r, 'warn');
  });

  client.initialize();
}

/* =========================
   UPLOAD ZIP
========================= */
app.post('/upload', async (req, res) => {
  try {
    if (!req.files?.zip) {
      return res.status(400).send('ZIP não enviado');
    }

    const name = 'session_' + Date.now();
    const zipPath = path.join(TEMP, name + '.zip');
    const sessionPath = path.join(SESSIONS, name);

    await req.files.zip.mv(zipPath);

    log('📥 ZIP recebido');

    if (!isValidZip(zipPath)) {
      log('❌ Arquivo não é ZIP válido', 'error');
      return res.status(400).send('Arquivo inválido');
    }

    fs.mkdirSync(sessionPath);
    log('📦 Extraindo sessão...');
    await extract(zipPath, sessionPath);

    startWhatsApp(sessionPath);
    res.sendStatus(200);

  } catch (e) {
    log('❌ Erro: ' + e.message, 'error');
    res.status(500).send('Erro interno');
  }
});

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
      maxRedirects: 5
    });

    const writer = fs.createWriteStream(zipPath);
    response.data.pipe(writer);

    writer.on('finish', async () => {
      if (!isValidZip(zipPath)) {
        log('❌ Download não é ZIP válido', 'error');
        return;
      }

      fs.mkdirSync(sessionPath);
      log('📦 Extraindo sessão...');
      await extract(zipPath, sessionPath);
      startWhatsApp(sessionPath);
    });

    res.sendStatus(200);

  } catch (e) {
    log('❌ Erro URL: ' + e.message, 'error');
    res.status(500).send();
  }
});

/* =========================
   SOCKET
========================= */
io.on('connection', socket => {
  socketRef = socket;
  log('🔌 Cliente conectado');
});

server.listen(10000, () =>
  console.log('🚀 Servidor rodando na porta 10000')
);
