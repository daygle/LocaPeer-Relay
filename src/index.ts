import { createRelay } from './relay';

const PORT = parseInt(process.env.PORT ?? '7777');

const wss = createRelay(PORT);

wss.on('listening', () => {
  console.log(`locapeer-relay listening on ws://0.0.0.0:${PORT}`);
});

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
