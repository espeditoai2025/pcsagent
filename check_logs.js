const { Client } = require('ssh2');
const conn = new Client();

conn.on('ready', () => {
  conn.exec('pm2 logs ai-agent --lines 20', (err, stream) => {
    if (err) throw err;
    stream.on('close', () => conn.end())
          .on('data', data => process.stdout.write(data))
          .stderr.on('data', data => process.stderr.write(data));
  });
}).connect({ host: '187.124.221.180', port: 22, username: 'root', password: 'Espe@23041976' });
