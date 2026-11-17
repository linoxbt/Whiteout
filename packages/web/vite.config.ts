import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, fs: { allow: ['../..'] } },
  build: { target: 'es2022', sourcemap: true },
  test: { environment: 'jsdom' },
} as never);
