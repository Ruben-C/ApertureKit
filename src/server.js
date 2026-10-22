import { createApp } from './app.js';
import { db } from './db.js';
import { PORT, HOST, DATA_DIR } from './config.js';
import { getSettings, sessionLimits } from './settings.js';
import { purgeExpired } from './sessions.js';

const app = createApp();
const server = app.listen(PORT, HOST, () => {
  console.log(`ApertureKit listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});

// Expired sessions are refused when used; this just keeps the table small.
const purge = () => purgeExpired(sessionLimits(getSettings()));
purge();
setInterval(purge, 60 * 60 * 1000).unref();

// As PID 1 in a container Node ignores SIGTERM unless a handler is installed,
// so `docker stop` would wait out its grace period and then kill mid-write.
// Stop accepting connections, let in-flight requests finish, close SQLite.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
