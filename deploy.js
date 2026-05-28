require('dotenv').config();
const { Client } = require('ssh2');

const conn = new Client();

const commands = `
set -e
echo "Aggiornamento pacchetti..."
apt-get update -y

echo "Installazione di curl, git e Node.js..."
apt-get install -y curl git
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs docker-compose
curl -fsSL https://get.docker.com | sh || true

echo "Installazione di PM2..."
npm install -g pm2

echo "Setup repository /opt/ai-agent-backend..."
mkdir -p /opt
cd /opt

if [ -d "ai-agent-backend" ]; then
  echo "Repository esistente, sincronizzo con origin/main..."
  cd ai-agent-backend
  git fetch --all
  git reset --hard origin/main
else
  echo "Clonazione repository..."
  git clone https://github.com/espeditoai2025/pcsagent.git ai-agent-backend
  cd ai-agent-backend
fi

echo "Creazione file .env..."
cat << 'EOF' > .env
OPENROUTER_API_KEY="${process.env.OPENROUTER_API_KEY || ''}"
OPENAI_API_KEY="${process.env.OPENAI_API_KEY || ''}"
APP_URL="http://187.124.221.180:3005"
PORT=3005
VPS_IP="187.124.221.180"
VPS_USER="root"
VPS_PASSWORD="${process.env.VPS_PASSWORD || ''}"
HOSTINGER_API_TOKEN="${process.env.HOSTINGER_API_TOKEN || ''}"
DATABASE_URL="postgresql://root:rootpassword@localhost:5432/agentdb?schema=public"
EOF

echo "Installazione dipendenze progetto..."
npm install

echo "Avvio del database (Docker Compose)..."
docker-compose up -d

echo "Allineamento schema database (Prisma)..."
npx prisma generate
npx prisma db push --accept-data-loss

echo "Build del progetto TypeScript..."
npm run build

echo "Avvio del servizio con PM2..."
pm2 stop ai-agent || true
pm2 start dist/server.js --name "ai-agent"
pm2 save
pm2 startup | tail -n 1 | bash || true

echo "Setup completato con successo. Porta 3000 in ascolto."
`;

console.log("Connessione in corso al VPS 187.124.221.180...");

conn.on('ready', () => {
  console.log('Connesso con successo!');
  conn.exec(commands, (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      console.log('Esecuzione completata con codice: ' + code);
      conn.end();
    }).on('data', (data) => {
      process.stdout.write(data);
    }).stderr.on('data', (data) => {
      process.stderr.write(data);
    });
  });
}).connect({
  host: '187.124.221.180',
  port: 22,
  username: 'root',
  password: 'Espe@23041976',
  readyTimeout: 99999
});
