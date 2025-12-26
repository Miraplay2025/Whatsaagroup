const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors:{ origin:'*' } });

app.use(cors());
app.use(express.static('public'));

const upload = multer({ dest:'uploads/' });
let activeClient = null;

function log(socket,msg){
  console.log(msg);
  socket.emit('log', msg);
}

/* =======================
   UPLOAD ZIP
======================= */
app.post('/upload', upload.single('zip'), (req,res)=>{
  if(!req.file) return res.status(400).send('ZIP não enviado');

  const zip = new AdmZip(req.file.path);
  zip.extractAllTo('.wwebjs_auth', true);
  fs.unlinkSync(req.file.path);

  res.json({ ok:true });
});

/* =======================
   SOCKET
======================= */
io.on('connection', socket=>{

  socket.on('validate-session', async session=>{
    log(socket,'🔍 Validando sessão...');

    const authPath = path.join(__dirname,'.wwebjs_auth',`session-${session}`);
    if(!fs.existsSync(authPath)){
      log(socket,'❌ Sessão NÃO existe');
      socket.emit('invalid');
      return;
    }

    const client = new Client({
      authStrategy: new LocalAuth({ clientId:session }),
      puppeteer:{ headless:true, args:['--no-sandbox'] }
    });

    activeClient = client;

    client.on('ready', async ()=>{
      const info = client.info;

      socket.emit('account',{
        name: info.pushname,
        number: info.wid.user
      });

      const chats = await client.getChats();
      const groups = chats.filter(c=>c.isGroup);

      if(!groups.length){
        socket.emit('no-groups');
      } else {
        socket.emit('groups',
          groups.map(g=>({
            name:g.name,
            total:g.participants.length
          }))
        );
      }

      log(socket,'✅ Sessão ATIVA e válida');
    });

    client.on('auth_failure', ()=>{
      log(socket,'❌ Sessão inválida');
      socket.emit('invalid');
    });

    client.initialize();
  });

  socket.on('send-message', async d=>{
    if(!activeClient) return;
    try{
      await activeClient.sendMessage(
        `${d.number}@c.us`,
        d.message
      );
      log(socket,'📨 Mensagem enviada com sucesso');
    }catch{
      log(socket,'❌ Erro ao enviar mensagem');
    }
  });

});

const PORT = process.env.PORT || 10000;
server.listen(PORT,()=>console.log('Servidor ativo'));
