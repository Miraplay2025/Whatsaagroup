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
app.use(express.static('public'));
app.use(fileUpload());

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

function log(socket, msg) {
  console.log(msg);
  socket.emit('log', msg);
}

/* ======================
   DOWNLOAD ZIP (URL)
====================== */
async function downloadZip(url, dest) {
  const res = await axios({ url, method: 'GET', responseType: 'stream' });
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(dest);
    res.data.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

/* ======================
   VALIDATE ZIP
====================== */
function isZip(filePath) {
  return filePath.endsWith('.zip');
}

/* ======================
   SOCKET
====================== */
io.on('connection', socket => {

  socket.on('restore-session', async data => {
    try {
      const sessionName = `restore_${Date.now()}`;
      const zipPath = path.join(__dirname, 'temp', `${sessionName}.zip`);
      const sessionPath = path.join(SESSIONS_DIR, sessionName);

      if (!fs.existsSync('temp')) fs.mkdirSync('temp');

      log(socket, '📥 Recebendo ZIP...');

      if (data.type === 'upload') {
        await data.file.mv(zipPath);
      }

      if (data.type === 'url') {
        await downloadZip(data.url, zipPath);
      }

      if (!isZip(zipPath)) {
        log(socket, '❌ Arquivo não é ZIP');
        return;
      }

      log(socket, '📦 Extraindo sessão...');
      fs.mkdirSync(sessionPath);

      await fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: sessionPath }))
        .promise();

      log(socket, '🚀 Iniciando WhatsApp...');

      const client = new Client({
        authStrategy: new LocalAuth({ dataPath: sessionPath }),
        puppeteer: {
          headless: true,
          args: ['--no-sandbox']
        }
      });

      client.on('ready', async () => {
        log(socket, '✅ Sessão válida e conectada');

        const info = client.info;
        const chats = await client.getChats();
        const groups = chats.filter(c => c.isGroup);

        const groupData = [];
        for (const g of groups) {
          const meta = await g.getChat();
          groupData.push({
            name: meta.name,
            members: meta.participants.length
          });
        }

        socket.emit('session-data', {
          number: info.wid.user,
          name: info.pushname,
          groups: groupData
        });
      });

      client.on('auth_failure', () => {
        log(socket, '❌ Sessão inválida ou expirada');
      });

      client.initialize();

    } catch (e) {
      log(socket, '❌ Erro: ' + e.message);
    }
  });
});

server.listen(10000, () =>
  console.log('🚀 Restore server rodando na porta 10000')
);
