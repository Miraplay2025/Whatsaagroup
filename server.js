const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const AdmZip = require('adm-zip');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let clientInstance = null;

function log(socket, msg) {
  console.log(msg);
  socket.emit('log', msg);
}

/* =========================
   GOOGLE DRIVE DOWNLOAD
========================= */
async function downloadFromDrive(link, socket) {
  log(socket, '🔍 Extraindo ID do arquivo...');
  const match = link.match(/[-\w]{25,}/);
  if (!match) throw new Error('Link inválido');

  const fileId = match[0];
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  log(socket, '⬇️ Baixando arquivo do Google Drive...');

  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error('Falha ao baixar arquivo');

  const buffer = await res.buffer();
  const zipPath = path.join(__dirname, 'session.zip');
  fs.writeFileSync(zipPath, buffer);

  log(socket, '✅ Arquivo baixado com sucesso');
  return zipPath;
}

/* =========================
   VALIDAR ZIP
========================= */
function validateZip(zipPath, socket) {
  log(socket, '🧪 Validando arquivo ZIP...');
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().map(e => e.entryName);
  if (!entries.some(e => e.includes('.wwebjs_auth')))
    throw new Error('Sessão WhatsApp não encontrada');
  log(socket, '✅ ZIP validado como sessão WhatsApp');
}

/* =========================
   EXTRAIR SESSÃO
========================= */
function extractSession(zipPath, socket) {
  log(socket, '📂 Extraindo sessão...');
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(__dirname, true);
  fs.unlinkSync(zipPath);
  log(socket, '✅ Sessão pronta');
}

/* =========================
   BUSCAR INFORMAÇÕES
========================= */
async function fetchSessionInfo(socket) {
  if (!clientInstance) return;
  log(socket, '🔎 Buscando informações da conta...');
  const info = clientInstance.info;
  const chats = await clientInstance.getChats();
  const groups = chats.filter(c => c.isGroup);

  socket.emit('session-info', {
    name: info.pushname,
    number: info.me.user,
    groups: groups.map(g => ({
      name: g.name,
      members: g.participants?.length || 0
    }))
  });
  log(socket, '🎉 Informações buscadas com sucesso');
}

/* =========================
   INICIAR WHATSAPP
========================= */
function startWhatsApp(socket) {
  if (clientInstance) {
    log(socket, '⚠️ WhatsApp já estava conectado. Buscando informações...');
    fetchSessionInfo(socket);
    return;
  }

  log(socket, '🚀 Iniciando WhatsApp...');

  clientInstance = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: ['--no-sandbox','--disable-setuid-sandbox']
    }
  });

  clientInstance.on('ready', async () => {
    log(socket, '✅ WhatsApp conectado');
    await fetchSessionInfo(socket);
  });

  clientInstance.on('auth_failure', () => {
    log(socket, '❌ Falha de autenticação');
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

  socket.on('start-from-drive', async link => {
    try {
      // Se já conectado, apenas busca info
      if (clientInstance) {
        log(socket, '⚠️ WhatsApp já estava conectado. Buscando informações...');
        await fetchSessionInfo(socket);
        return;
      }

      const zipPath = await downloadFromDrive(link, socket);
      validateZip(zipPath, socket);
      extractSession(zipPath, socket);
      startWhatsApp(socket);

    } catch (e) {
      log(socket, `❌ Erro: ${e.message}`);
    }
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
      log(socket, `❌ Erro ao enviar mensagem: ${e.message}`);
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
