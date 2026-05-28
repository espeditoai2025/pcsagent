const { Client } = require('ssh2');
const conn = new Client();

const commands = `
cd /opt/ai-agent-backend
sed -i 's/PORT=3000/PORT=3005/' .env
pm2 restart ai-agent
`;

conn.on('ready', () => {
  conn.exec(commands, (err, stream) => {
    if (err) throw err;
    stream.on('close', () => conn.end())
          .on('data', data => process.stdout.write(data))
          .stderr.on('data', data => process.stderr.write(data));
  });
}).connect({ host: '187.124.221.180', port: 22, username: 'root', password: 'Espe@23041976' });
