// Text reading with a self-hosted tesseract.js. Loaded only when scanning starts.
/* global __OCR_PATH__ */

let workerPromise = null;
let listener = null;

/** Starts (or reuses) the OCR worker. onProgress(status, 0–1) reports the first-time download. */
export function ocrWorker(onProgress) {
  listener = onProgress ?? null;
  workerPromise ??= (async () => {
    const { default: Tesseract } = await import('tesseract.js/dist/tesseract.esm.min.js');
    // OEM 1 = LSTM only, which is what the hosted cores and model are built for.
    const worker = await Tesseract.createWorker('eng', 1, {
      workerPath: `${__OCR_PATH__}worker.min.js`,
      corePath: __OCR_PATH__,
      langPath: __OCR_PATH__,
      cachePath: __OCR_PATH__,
      workerBlobURL: false,
      gzip: true,
      logger: (m) => listener?.(m.status, m.progress ?? 0),
    });
    // Auto-scan often reads blank frames, which makes Tesseract print debug stats to the console.
    await worker.setParameters({ debug_file: '/dev/null' });
    return worker;
  })();
  workerPromise.catch(() => (workerPromise = null));
  return workerPromise;
}

/**
 * Reads text from a canvas. mode 'line' for a title, 'block' for the collector text.
 * Returns { text, confidence } with confidence 0–1.
 */
export async function readText(canvas, mode = 'line') {
  const worker = await ocrWorker();
  await worker.setParameters({ tessedit_pageseg_mode: mode === 'line' ? '7' : '6' });
  const { data } = await worker.recognize(canvas);
  return { text: (data.text ?? '').trim(), confidence: (data.confidence ?? 0) / 100 };
}

export async function stopOcr() {
  const p = workerPromise;
  workerPromise = null;
  if (p) await (await p).terminate().catch(() => {});
}
