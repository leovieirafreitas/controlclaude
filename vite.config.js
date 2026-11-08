import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const API_PORT = process.env.PORT || 3000;

// /assinar abre a página de vendas (assinar.html) também no modo dev
const salesRoute = {
  name: 'sales-route',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      for (const page of ['/assinar', '/conta', '/termos', '/privacidade']) {
        if (req.url === page || req.url.startsWith(`${page}?`)) req.url = req.url.replace(page, `${page}.html`);
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [salesRoute],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${API_PORT}`,
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        assinar: resolve(import.meta.dirname, 'assinar.html'),
        conta: resolve(import.meta.dirname, 'conta.html'),
        termos: resolve(import.meta.dirname, 'termos.html'),
        privacidade: resolve(import.meta.dirname, 'privacidade.html'),
      },
    },
  },
});
