import path from 'node:path';

const IMAGE_TYPES = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.heic', 'image/heic'], ['.heif', 'image/heif'],
]);

const sendStoredFile = (res, filePath) => {
  const contentType = IMAGE_TYPES.get(path.extname(filePath).toLowerCase());
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Old batches predate validation and may contain arbitrary filename extensions.
  // Keep these downloadable, but never serve them as executable web content.
  res.setHeader('Content-Type', contentType || 'application/octet-stream');
  if (!contentType) res.setHeader('Content-Disposition', 'attachment');
  res.sendFile(filePath, (error) => {
    if (!error) return;
    if (res.headersSent) { res.destroy(); return; }
    res.status(error.statusCode === 404 ? 404 : 500).end();
  });
};

export { sendStoredFile };
