import { createRelay } from './relay';

const PORT = parseInt(process.env.PORT ?? '7777');

const wss = createRelay(PORT);

wss.on('listening', () => {
  console.log(`locapeer-relay listening on ws://0.0.0.0:${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  wss.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  wss.close(() => process.exit(0));
});
