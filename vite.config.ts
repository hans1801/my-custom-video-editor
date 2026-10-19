import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export const SERVER_PORT = 5175;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/api': `http://127.0.0.1:${SERVER_PORT}` },
  },
});
