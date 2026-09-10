import { defineConfig } from "vite";

// The backend (apps/server) listens on port 3001 by default.
const API_TARGET = process.env.API_TARGET || "http://localhost:3001";

export default defineConfig({
  server: {
    strictPort: true,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
