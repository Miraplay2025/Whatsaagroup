const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');
const ZIP_PATH = path.join(__dirname, 'session.zip');

let clientInstance = null;

/* =========================
   LOG CENTRAL
========================= */
function log(socket, msg) {
  console.log(msg);
  socket.emit('log', msg);
}

/* =========================
   LIMPAR SESSÃO
========================= */
function clearSession() {
  if (fs.existsSync(SESSION_DIR)) {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  }
}

/* =========================
   VALIDAR ZIP REAL
========================= */
function isZipFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(2);
  fs.readSync(fd, buffer, 0, 2, 0);
  fs.closeSync(fd);
  return buffer.toString() === 'PK';
}

/* =========================
   DOWNLOAD COM CURL (ROBUSTO)
========================= */
function downloadWithCurl(socket, url) {
  return new Promise((resolve, reject) => {
    log(socket, '⬇️ Baixando arquivo ZIP (curl)...');

    if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH);

    const cmd = `curl -L --fail --silent --show-error "${url}" -o "${ZIP_PATH}"`;

    exec(cmd, (error) => {
      if (error) {
        return reject(new Error('Falha ao baixar arquivo (curl)'));
      }

      if (!fs.existsSync(ZIP_PATH)) {
        return reject(new Error('Arquivo não foi baixado'));
      }

      if (!isZipFile(ZIP_PATH)) {
        fs.unlinkSync(ZIP_PATH);
        return reject(
          new Error('Arquivo baixado NÃO é um ZIP válido')
        );
      }

      log(socket, '✅ Arquivo ZIP baixado com sucesso');
      resolve(ZIP_PATH);
    });
  });
}

/* =========================
   EXTRAIR ZIP
========================= */
function extractZip(socket) {
  log(socket, '📦 Extraindo arquivos da sessão...');
  clearSession();

  const zip = new AdmZip(ZIP_PATH);
  zip.extractAllTo(SESSION_DIR, true);

  fs.unlinkSync(ZIP_PATH);
  log(socket, '✅ Arquivos extraídos');
}

/* =========================
   AGUARDAR INFO REAL
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
   INICIAR WHATSAPP
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
   SOCKET.IO
========================= */
io.on('connection', socket => {

  socket.on('start-from-link', async url => {
    try {
      log(socket, '🚀 Iniciando processo...');
      await downloadWithCurl(socket, url);
      extractZip(socket);
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
