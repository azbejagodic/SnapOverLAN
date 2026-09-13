import { Worker } from 'node:worker_threads';

// Allow full-resolution 48/50 MP phone photos (clipboard copying has a separate
// 40 MP limit), with headroom, without accepting arbitrary decompression sizes.
const MAX_UPLOAD_PIXELS = 60_000_000;
let validationQueue = Promise.resolve();

const validateImage = (filePath) => {
  // Decode only one uploaded image at a time, including across concurrent batches.
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./image-validation-worker.js', import.meta.url), {
      workerData: { filePath, maxPixels: MAX_UPLOAD_PIXELS },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let settled = false;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Image validation timed out.')), 30000);
    worker.once('message', (message) => finish(message.error ? new Error(message.error) : null, message));
    worker.once('error', (error) => finish(error));
    worker.once('exit', () => finish(new Error('Image validation did not complete.')));
  });
  const result = validationQueue.then(run, run);
  validationQueue = result.catch(() => {});
  return result;
};

export { MAX_UPLOAD_PIXELS, validateImage };
