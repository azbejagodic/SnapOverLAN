const MAX_MANUAL_COPY_BYTES = 32 * 1024 * 1024;
const MAX_MANUAL_COPY_PIXELS = 40_000_000;

const toBuffer = (value) => {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
};

const getImageSize = (image) => {
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
    || width * height > MAX_MANUAL_COPY_PIXELS
  ) {
    return null;
  }
  return { width, height };
};

const copyImageBytesToClipboard = ({
  imageBytes,
  createImageFromBuffer,
  writeImage,
}) => {
  const sourceBuffer = toBuffer(imageBytes);
  if (
    !sourceBuffer
    || sourceBuffer.length === 0
    || sourceBuffer.length > MAX_MANUAL_COPY_BYTES
  ) {
    throw new Error('Image data is empty or too large to copy.');
  }
  if (typeof createImageFromBuffer !== 'function' || typeof writeImage !== 'function') {
    throw new Error('Image clipboard support is unavailable.');
  }

  const sourceImage = createImageFromBuffer(sourceBuffer);
  const sourceSize = getImageSize(sourceImage);
  if (!sourceSize || typeof sourceImage.toPNG !== 'function') {
    throw new Error('Electron could not decode the selected image.');
  }

  const pngBuffer = toBuffer(sourceImage.toPNG());
  if (!pngBuffer || pngBuffer.length === 0) {
    throw new Error('Electron could not convert the selected image to PNG.');
  }

  const clipboardImage = createImageFromBuffer(pngBuffer);
  const clipboardSize = getImageSize(clipboardImage);
  if (!clipboardSize) {
    throw new Error('Electron could not decode the converted PNG.');
  }

  writeImage(clipboardImage);
  return clipboardSize;
};

export {
  MAX_MANUAL_COPY_BYTES,
  MAX_MANUAL_COPY_PIXELS,
  copyImageBytesToClipboard,
};
