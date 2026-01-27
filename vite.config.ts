import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // Permet d'utiliser process.env dans le code frontend via le shim index.html
    'process.env': process.env
  },
  build: {
    outDir: 'dist',
  }
});