import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { copyOcrAssets, ocrVersion } from './scripts/ocr-assets.mjs';

copyOcrAssets();

// `npm run dev:phone` serves over HTTPS on the LAN so a phone can use the camera (browsers require a secure origin).
const phone = process.env.MTG_PHONE === '1';

export default defineConfig({
  plugins: phone ? [basicSsl()] : [],
  server: phone ? { host: true } : {},
  define: {
    __OCR_PATH__: JSON.stringify(`/ocr/${ocrVersion()}/`),
  },
  // Loaded lazily, so declare it up front instead of having the dev server discover it mid-session.
  optimizeDeps: {
    include: ['tesseract.js/dist/tesseract.esm.min.js'],
  },
  build: {
    target: 'es2022',
  },
});
