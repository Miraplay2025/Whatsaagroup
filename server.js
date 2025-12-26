const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let clientInstance = null;

/* =========================
   LOG CENTRAL
========================= */
function log(socket, msg) {
  console.log(msg);
  socket.emit('log', msg);
}

/* =========================
   BAIXAR ZIP DO DRIVE
========================= */
async function downloadZipFromDrive(driveLink, socket) {
  log(socket, '⬇️ Baixando arquivo ZIP...');

  const match = driveLink.match(/\/d\/([^/]+)/);
  if (!match) throw new Error('Link do Drive inválido');

  const fileId = match[1];
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  const zipPath = path.join(__dirname, 'session.zip');
  const response = await axios({
    url: downloadUrl,
    method: 'GET',
    responseType: 'stream'
  });

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(zipPath);
    response.data.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  log(socket, '✅ Arquivo ZIP baixado com sucesso');
  return zipPath;
}

/* =========================
   EXTRAIR ZIP
========================= */
function extractZip(zipPath, socket) {
  log(socket, '📦 Extraindo arquivos da sessão...');
  const zip = new AdmZip(zipPath);

  const authDir = path.join(__dirname, '.wwebjs_auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir);

  zip.extractAllTo(authDir, true);
  fs.unlinkSync(zipPath);

  log(socket, '✅ Arquivos extraídos');
}

/* =========================
   INICIAR WHATSAPP
========================= */
function startWhatsApp(socket) {
  if (clientInstance) {
    log(socket, 'ℹ️ WhatsApp já estava conectado, buscando informações...');
    fetchInfo(socket);
    return;
  }

  log(socket, '🚀 Iniciando WhatsApp...');

  clientInstance = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    }
  });

  clientInstance.on('ready', () => {
    log(socket, '✅ WhatsApp conectado com sucesso');
    fetchInfo(socket);
  });

  clientInstance.on('auth_failure', () => {
    log(socket, '❌ Sessão inválida ou expirada (ZIP não autenticou)');
    clientInstance = null;
  });

  clientInstance.on('disconnected', reason => {
    log(socket, `❌ WhatsApp desconectado: ${reason}`);
    clientInstance = null;
  });

  clientInstance.initialize();
}

/* =========================
   BUSCAR INFORMAÇÕES
========================= */
async function fetchInfo(socket) {
  const info = clientInstance.info;
  log(socket, `👤 Conta: ${info.pushname} (${info.me.user})`);

  const chats = await clientInstance.getChats();
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
}

/* =========================
   SOCKET
========================= */
io.on('connection', socket => {

  socket.on('start-from-drive', async driveLink => {
    try {
      const zipPath = await downloadZipFromDrive(driveLink, socket);
      extractZip(zipPath, socket);
      log(socket, '🔐 Tentando autenticar no WhatsApp...');
      startWhatsApp(socket);
    } catch (e) {
      log(socket, '❌ Erro: ' + e.message);
    }
  });

  socket.on('send-message', async data => {
    if (!clientInstance) {
      log(socket, '❌ WhatsApp não conectado');
      return;
    }

    const number = data.number.replace(/\D/g, '') + '@c.us';
    log(socket, `📨 Enviando mensagem para ${data.number}...`);

    try {
      await clientInstance.sendMessage(number, data.message);
      log(socket, '✅ Mensagem enviada');
    } catch {
      log(socket, '❌ Falha ao enviar mensagem');
    }
  });

});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`);
});
