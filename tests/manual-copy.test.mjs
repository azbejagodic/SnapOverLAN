import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_MANUAL_COPY_BYTES,
  copyImageBytesToClipboard,
} from '../app/manual-copy.js';

const fakeImage = ({ width = 32, height = 20, empty = false, toPNG } = {}) => ({
  getSize: () => ({ width, height }),
  isEmpty: () => empty,
  toPNG,
});

test('manual Copy writes the decoded PNG image and never URL text', () => {
  const sourceBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const clipboardImage = fakeImage();
  let decodeCall = 0;
  const clipboardWrites = {
    images: [],
    text: [],
  };

  const dimensions = copyImageBytesToClipboard({
    imageBytes: sourceBytes,
    createImageFromBuffer: (buffer) => {
      decodeCall += 1;
      if (decodeCall === 1) {
        assert.deepEqual(buffer, sourceBytes);
        return fakeImage({ toPNG: () => pngBytes });
      }
      assert.deepEqual(buffer, pngBytes);
      return clipboardImage;
    },
    writeImage: (image) => clipboardWrites.images.push(image),
    writeText: (text) => clipboardWrites.text.push(text),
  });

  assert.deepEqual(dimensions, { width: 32, height: 20 });
  assert.deepEqual(clipboardWrites.images, [clipboardImage]);
  assert.deepEqual(clipboardWrites.text, []);
});

test('manual Copy failures leave the clipboard untouched', () => {
  let imageWrites = 0;

  assert.throws(
    () => copyImageBytesToClipboard({
      imageBytes: Buffer.from('not an image'),
      createImageFromBuffer: () => fakeImage({ empty: true }),
      writeImage: () => { imageWrites += 1; },
    }),
    /could not decode/i,
  );
  assert.equal(imageWrites, 0);

  assert.throws(
    () => copyImageBytesToClipboard({
      imageBytes: Buffer.alloc(MAX_MANUAL_COPY_BYTES + 1),
      createImageFromBuffer: () => {
        throw new Error('decode should not run');
      },
      writeImage: () => { imageWrites += 1; },
    }),
    /empty or too large/i,
  );
  assert.equal(imageWrites, 0);
});
