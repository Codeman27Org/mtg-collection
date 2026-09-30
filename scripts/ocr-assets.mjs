// Copies the self-hosted OCR files (tesseract.js worker, LSTM cores, English model) into public/ocr/<version>/.
// The folder name changes whenever a package version does, so deploys can cache it forever.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = (name) => join(root, 'node_modules', name);
const version = (name) => JSON.parse(readFileSync(join(mod(name), 'package.json'), 'utf8')).version;

export const ocrVersion = () =>
  `t${version('tesseract.js')}-c${version('tesseract.js-core')}-eng${version('@tesseract.js-data/eng')}`;

export function copyOcrAssets() {
  const base = join(root, 'public', 'ocr');
  const out = join(base, ocrVersion());
  if (existsSync(out)) return out;
  if (existsSync(base)) for (const old of readdirSync(base)) rmSync(join(base, old), { recursive: true });
  mkdirSync(out, { recursive: true });

  copyFileSync(join(mod('tesseract.js'), 'dist', 'worker.min.js'), join(out, 'worker.min.js'));
  // Only the LSTM engine is used (oem 1); the worker picks one of these by the device's WebAssembly support.
  for (const core of ['tesseract-core-relaxedsimd-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-lstm']) {
    copyFileSync(join(mod('tesseract.js-core'), `${core}.wasm.js`), join(out, `${core}.wasm.js`));
  }
  // The integer model is a quarter the size of the full one and is what tesseract.js uses for LSTM by default.
  copyFileSync(
    join(mod('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'),
    join(out, 'eng.traineddata.gz'),
  );
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`OCR assets in ${copyOcrAssets()}`);
