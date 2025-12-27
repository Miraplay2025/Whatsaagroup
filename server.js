const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const AdmZip = require('adm-zip');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');
let clientInstance = null;

/* =========================
   LOG CENTRAL (100% VISÍVEL)
========================= */
function log(socket, msg) {
  console.log(msg);
  socket.emit('log', msg);
}

/* =========================
   AGUARDAR INFO REAL DO WHATSAPP
========================= */
async function waitForClientInfo(client, timeout = 20000) {
  const start = Date.now();
  while (!client.info) {
    if (Date.now() - start > timeout) {
      throw new Error('Timeout ao aguardar informações da conta');
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return client.info;
}

/* =========================
   LIMPAR SESSÃO ANTERIOR
========================= */
function clearSession() {
  if (fs.existsSync(SESSION_DIR)) {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  }
}

/* =========================
   BAIXAR ZIP DO DRIVE
========================= */
async function downloadZip(socket, fileUrl) {
  log(socket, '⬇️ Baixando arquivo ZIP...');

  const res = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  const zipPath = path.join(__dirname, 'session.zip');

  fs.writeFileSync(zipPath, res.data);
  log(socket, '✅ Arquivo ZIP baixado com sucesso');

  return zipPath;
}

/* =========================
   EXTRAIR ZIP (SEM VALIDAR)
========================= */
function extractZip(socket, zipPath) {
  log(socket, '📦 Extraindo arquivos da sessão...');

  clearSession();
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(SESSION_DIR, true);

  fs.unlinkSync(zipPath);
  log(socket, '✅ Arquivos extraídos');
}

/* =========================
   INICIAR WHATSAPP (QUEM VALIDA É ELE)
========================= */
async function startWhatsApp(socket) {
  if (clientInstance) {
    log(socket, 'ℹ️ WhatsApp já estava conectado, buscando informações...');
    await fetchInfo(socket);
    return;
  }

  log(socket, '🔐 Tentando autenticar no WhatsApp...');
  log(socket, 'ℹ️ Iniciando WhatsApp...');

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
    log(socket, '✅ WhatsApp respondeu: sessão VÁLIDA');
    await fetchInfo(socket);
  });

  clientInstance.on('auth_failure', () => {
    log(socket, '❌ WhatsApp respondeu: sessão EXPIRADA ou INVÁLIDA');
    clientInstance = null;
  });

  clientInstance.on('disconnected', reason => {
    log(socket, `❌ WhatsApp desconectado: ${reason}`);
    clientInstance = null;
  });

  clientInstance.initialize();
}

/* =========================
   BUSCAR INFO + GRUPOS
========================= */
async function fetchInfo(socket) {
  try {
    log(socket, '⏳ Buscando informações da conta...');
    const info = await waitForClientInfo(clientInstance);

    const name = info.pushname || 'Sem nome';
    const number = info.me?.user || 'Desconhecido';

    log(socket, `👤 Conta: ${name} (${number})`);

    let chats = [];
    try {
      chats = await clientInstance.getChats();
    } catch {
      log(socket, '⚠️ Erro ao buscar chats');
    }

    const groups = chats.filter(c => c.isGroup);
    log(socket, `📦 Grupos encontrados: ${groups.length}`);

    socket.emit('session-info', {
      name,
      number,
      groups: groups.map(g => ({
        name: g.name,
        members: g.participants?.length || 0
      }))
    });

  } catch (err) {
    log(socket, `❌ Erro ao obter informações: ${err.message}`);
  }
}

/* =========================
   SOCKET.IO
========================= */
io.on('connection', socket => {

  socket.on('start-from-link', async fileUrl => {
    try {
      const zipPath = await downloadZip(socket, fileUrl);
      extractZip(socket, zipPath);
      await startWhatsApp(socket);
    } catch (err) {
      log(socket, `❌ Erro geral: ${err.message}`);
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
    } catch {
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
