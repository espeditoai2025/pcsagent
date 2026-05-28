const { Client } = require('ssh2');

const conn = new Client();
const script = `
cat << 'EOF' > /opt/ai-agent-backend/run_test.js
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');

async function run() {
  const prisma = new PrismaClient();
  
  // Crea o ottieni un utente
  let user = await prisma.user.findFirst();
  if (!user) {
    user = await prisma.user.create({ data: { email: "test@example.com", name: "Test User" } });
  }

  // Crea un agente
  let agent = await prisma.agentInstance.findFirst({ where: { userId: user.id } });
  if (!agent) {
    agent = await prisma.agentInstance.create({ data: { name: "Test Agent", userId: user.id } });
  }

  // Crea una sessione
  const session = await prisma.chatSession.create({
    data: { userId: user.id, agentId: agent.id }
  });

  console.log(JSON.stringify({ sessionId: session.id, userId: user.id }));
}
run().catch(console.error);
EOF

cd /opt/ai-agent-backend
node run_test.js
`;

conn.on('ready', () => {
  conn.exec(script, (err, stream) => {
    if (err) throw err;
    let out = '';
    stream.on('close', () => {
      console.log(out);
      conn.end();
    }).on('data', data => {
      out += data.toString();
    });
  });
}).connect({ host: '187.124.221.180', port: 22, username: 'root', password: 'Espe@23041976' });
