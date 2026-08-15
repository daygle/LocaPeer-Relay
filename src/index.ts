import { createRelay } from './relay';
import { startAdminServer } from './admin';

const PORT = parseInt(process.env.PORT ?? '7777', 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT "${process.env.PORT}" (expected an integer between 1 and 65535)`);
  process.exit(1);
}

const wss = createRelay(PORT);

wss.on('listening', () => {
  console.log(`locapeer-relay listening on ws://0.0.0.0:${PORT}`);
});

startAdminServer();

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down...`);
  // Terminate open connections so wss.close() doesn't hang on idle clients.
  for (const client of wss.clients) {
    client.terminate();
  }
  wss.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
