/**
 * PM2 ecosystem configuration for the ingestion daemon.
 *
 * Start:   npx pm2 start ecosystem.config.cjs
 * Stop:    npx pm2 stop ingest-daemon
 * Restart: npx pm2 restart ingest-daemon
 * Logs:    npx pm2 logs ingest-daemon
 * Status:  npx pm2 status
 */
module.exports = {
  apps: [
    {
      name: "ingest-daemon",
      script: "node_modules/.bin/tsx",
      args: "-r dotenv/config scripts/ingest-daemon.ts --interval=30 --force",
      cwd: __dirname,
      // Restart policy
      autorestart: true,
      max_restarts: 10,
      min_uptime: "30s",
      restart_delay: 10000, // 10s between restarts
      // Logs
      output: "./logs/daemon-out.log",
      error: "./logs/daemon-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
      // Environment
      env: {
        NODE_ENV: "development",
        DATABASE_URL:
          "postgresql://alvinhu:alvinhu@localhost:5434/autoapplication?schema=public",
      },
      // Memory guard — restart if daemon leaks past 512MB
      max_memory_restart: "512M",
    },
  ],
};
