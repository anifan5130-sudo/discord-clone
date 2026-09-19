import { defineConfig } from 'vite';

// В режиме разработки API проксируется на локальный сервер (npm start в server/).
export default defineConfig({
  build: { outDir: 'dist', target: 'es2022', assetsInlineLimit: 0 },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/rtc': { target: 'ws://127.0.0.1:7880', ws: true },
    },
  },
});
