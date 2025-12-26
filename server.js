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

let client = null;
let sessionId = null;

function log(socket,msg){
  console.log(msg);
  socket.emit('log', msg);
}

/* =========================
   VALIDAR WHATSAPP (ZIP)
========================= */
app.post('/validate', upload.single('zip'), async (req,res)=>{
  if(!req.file){
    return res.status(400).json({ error:'ZIP não enviado' });
  }

  // Limpa sessões antigas
  if (fs.existsSync('.wwebjs_auth')) {
    fs.rmSync('.wwebjs_auth', { recursive:true, force:true });
  }

  const zip = new AdmZip(req.file.path);
  zip.extractAllTo('.wwebjs_auth', true);
  fs.unlinkSync(req.file.path);

  const sessions = fs.readdirSync('.wwebjs_auth')
    .filter(f => f.startsWith('session-'));

  if(!sessions.length){
    return res.status(400).json({ error:'Nenhuma sessão encontrada no ZIP' });
  }

  sessionId = sessions[0].replace('session-','');
  res.json({ ok:true });
});

/* =========================
   SOCKET
========================= */
io.on('connection', socket=>{

  socket.on('start-validation', async ()=>{
    if(!sessionId){
      log(socket,'❌ Nenhuma sessão carregada');
      return;
    }

    log(socket,'🔍 Sessão encontrada, validando no WhatsApp...');

    client = new Client({
      authStrategy: new LocalAuth({ clientId:sessionId }),
      puppeteer:{
        headless:true,
        args:['--no-sandbox','--disable-setuid-sandbox']
      }
    });

    client.on('ready', async ()=>{
      log(socket,'✅ Sessão válida! Buscando informações...');

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
        socket.emit('groups', groups.map(g=>({
          name:g.name,
          total:g.participants.length
        })));
      }

      log(socket,'📊 Informações carregadas com sucesso');
    });

    client.on('auth_failure', ()=>{
      log(socket,'❌ Sessão inválida ou expirada');
    });

    client.initialize();
  });

  socket.on('send-message', async d=>{
    if(!client){
      log(socket,'❌ WhatsApp não conectado');
      return;
    }
    try{
      await client.sendMessage(`${d.number}@c.us`, d.message);
      log(socket,`📨 Mensagem enviada para ${d.number}`);
    }catch{
      log(socket,'❌ Erro ao enviar mensagem');
    }
  });

});

const PORT = process.env.PORT || 10000;
server.listen(PORT,()=>console.log('Servidor ativo'));
