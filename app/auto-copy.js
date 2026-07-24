import { promises as fs } from 'fs';
import path from 'path';

const UPLOAD_COMPLETED_EVENT = 'snapoverlan:upload-completed';
const MAX_AUTO_COPY_FILE_BYTES = 32 * 1024 * 1024;
const MAX_AUTO_COPY_PIXELS = 40_000_000;
const CLIPBOARD_VERIFY_DELAYS_MS = [50, 75];
let sharpModulePromise = null;

const getSharp = async () => {
  if (!sharpModulePromise) {
    sharpModulePromise = import('sharp').then((module) => module.default);
  }
  return sharpModulePromise;
};

const createAutoCopyError = (message, code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const validateUploadCompletedMessage = (message) => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return null;
  }
  if (message.type !== UPLOAD_COMPLETED_EVENT) {
    return null;
  }

  const batchId = typeof message.batchId === 'string' ? message.batchId.trim() : '';
  const firstImage = message.firstImage;
  if (!batchId || batchId.length > 256 || !firstImage || typeof firstImage !== 'object') {
    return null;
  }

  const name = typeof firstImage.name === 'string' ? firstImage.name.trim() : '';
  const filePath = typeof firstImage.path === 'string' ? firstImage.path.trim() : '';
  const mimeType = typeof firstImage.mimeType === 'string' ? firstImage.mimeType.trim() : '';
  if (
    !name
    || name.length > 512
    || name !== path.basename(name)
    || !path.isAbsolute(filePath)
    || !mimeType.startsWith('image/')
  ) {
    return null;
  }

  return {
    type: UPLOAD_COMPLETED_EVENT,
    batchId,
    firstImage: {
      name,
      path: filePath,
      mimeType,
    },
  };
};

const getUsableImageSize = (image) => {
  if (!image || typeof image.isEmpty !== 'function' || image.isEmpty()) {
    return null;
  }
  if (typeof image.getSize !== 'function') {
    return null;
  }

  const size = image.getSize();
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (
    !Number.isInteger(width)
    || !Number.isInteger(height)
    || width <= 0
    || height <= 0
    || width * height > MAX_AUTO_COPY_PIXELS
  ) {
    return null;
  }
  return { width, height };
};

const inspectImageMetadata = async (buffer) => {
  const sharp = await getSharp();
  return sharp(buffer, {
    failOn: 'error',
    limitInputPixels: MAX_AUTO_COPY_PIXELS,
  }).metadata();
};

const convertImageToPng = async (buffer) => {
  const sharp = await getSharp();
  const { data, info } = await sharp(buffer, {
    failOn: 'error',
    limitInputPixels: MAX_AUTO_COPY_PIXELS,
    sequentialRead: true,
  })
    .rotate()
    .png()
    .toBuffer({ resolveWithObject: true });

  if (
    !Number.isInteger(info.width)
    || !Number.isInteger(info.height)
    || info.width <= 0
    || info.height <= 0
    || info.width * info.height > MAX_AUTO_COPY_PIXELS
  ) {
    throw createAutoCopyError('Converted image dimensions are invalid or too large.', 'IMAGE_TOO_LARGE');
  }
  return data;
};

const decodeUploadedImage = async ({
  filePath,
  createImageFromPath,
  createImageFromBuffer,
  getFileSize = async (targetPath) => (await fs.stat(targetPath)).size,
  readFile = fs.readFile,
  inspectMetadata = inspectImageMetadata,
  convertToPng = convertImageToPng,
  onDiagnostic = () => {},
}) => {
  const fileSize = await getFileSize(filePath);
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > MAX_AUTO_COPY_FILE_BYTES) {
    throw createAutoCopyError('Uploaded image file is empty or exceeds the auto-copy limit.', 'IMAGE_TOO_LARGE');
  }

  let pathImage = null;
  let pathImageSize = null;
  try {
    pathImage = createImageFromPath(filePath);
    pathImageSize = getUsableImageSize(pathImage);
  } catch (error) {
    onDiagnostic('nativeImage path decode failed', { reason: error.message });
  }

  const buffer = await readFile(filePath);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_AUTO_COPY_FILE_BYTES) {
    throw createAutoCopyError('Uploaded image data is empty or exceeds the auto-copy limit.', 'IMAGE_TOO_LARGE');
  }

  let metadata = null;
  try {
    metadata = await inspectMetadata(buffer);
  } catch (error) {
    onDiagnostic('metadata inspection failed', { reason: error.message });
  }
  const requiresOrientationConversion = Number.isInteger(metadata?.orientation)
    && metadata.orientation > 1;

  if (pathImageSize && !requiresOrientationConversion) {
    return {
      image: pathImage,
      method: 'path',
      ...pathImageSize,
    };
  }

  let bufferImage = null;
  let bufferImageSize = null;
  try {
    bufferImage = createImageFromBuffer(buffer);
    bufferImageSize = getUsableImageSize(bufferImage);
  } catch (error) {
    onDiagnostic('nativeImage buffer decode failed', { reason: error.message });
  }

  if (bufferImageSize && !requiresOrientationConversion) {
    return {
      image: bufferImage,
      method: 'buffer',
      ...bufferImageSize,
    };
  }

  try {
    const pngBuffer = await convertToPng(buffer);
    const convertedImage = createImageFromBuffer(pngBuffer);
    const convertedSize = getUsableImageSize(convertedImage);
    if (!convertedSize) {
      throw new Error('Electron could not decode the converted PNG.');
    }
    return {
      image: convertedImage,
      method: requiresOrientationConversion ? 'oriented-png' : 'converted-png',
      ...convertedSize,
    };
  } catch (error) {
    throw createAutoCopyError(
      `Unsupported image format or malformed image data: ${error.message}`,
      'UNSUPPORTED_IMAGE',
    );
  }
};

const copyFirstUploadedImage = async ({
  message,
  enabled,
  fileExists,
  decodeImage,
  createImageFromPath,
  createImageFromBuffer,
  writeImage,
  readImage,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onDiagnostic = () => {},
}) => {
  if (!enabled) {
    return { status: 'disabled' };
  }

  const event = validateUploadCompletedMessage(message);
  if (!event) {
    return { status: 'ignored' };
  }

  const { name, path: filePath } = event.firstImage;
  onDiagnostic('IPC event received', {
    batchId: event.batchId,
    filename: name,
    mimeType: event.firstImage.mimeType,
  });

  try {
    if (!(await fileExists(filePath))) {
      throw new Error('The uploaded image is no longer available.');
    }
    onDiagnostic('file exists', { filename: name });

    const decoded = decodeImage
      ? await decodeImage(filePath)
      : await decodeUploadedImage({
        filePath,
        createImageFromPath,
        createImageFromBuffer,
        onDiagnostic,
      });
    onDiagnostic('nativeImage decoded', {
      filename: name,
      method: decoded.method,
      dimensions: `${decoded.width}x${decoded.height}`,
    });

    let clipboardImage = null;
    for (let attempt = 0; attempt < CLIPBOARD_VERIFY_DELAYS_MS.length; attempt += 1) {
      writeImage(decoded.image);
      onDiagnostic('clipboard write completed', { filename: name, attempt: attempt + 1 });
      await delay(CLIPBOARD_VERIFY_DELAYS_MS[attempt]);
      clipboardImage = readImage();
      const clipboardSize = getUsableImageSize(clipboardImage);
      if (clipboardSize) {
        onDiagnostic('clipboard readback verified', {
          filename: name,
          dimensions: `${clipboardSize.width}x${clipboardSize.height}`,
        });
        return {
          status: 'copied',
          filename: name,
          batchId: event.batchId,
          method: decoded.method,
          dimensions: clipboardSize,
        };
      }
    }

    throw new Error('Windows clipboard image readback was empty.');
  } catch (error) {
    const reason = error?.code === 'UNSUPPORTED_IMAGE' ? 'unsupported image format' : '';
    onDiagnostic('failed', { filename: name, reason: error.message });
    return {
      status: 'failed',
      filename: name,
      batchId: event.batchId,
      error: error instanceof Error ? error.message : String(error),
      reason,
    };
  }
};

export {
  CLIPBOARD_VERIFY_DELAYS_MS,
  MAX_AUTO_COPY_FILE_BYTES,
  MAX_AUTO_COPY_PIXELS,
  UPLOAD_COMPLETED_EVENT,
  copyFirstUploadedImage,
  decodeUploadedImage,
  validateUploadCompletedMessage,
};
