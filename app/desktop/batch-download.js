import { promises as fs } from 'fs';
import path from 'path';

const BATCH_ID_PATTERN = /^batch_[a-zA-Z0-9_-]+$/;

const assertValidBatchId = (batchId) => {
  if (typeof batchId !== 'string' || !BATCH_ID_PATTERN.test(batchId)) {
    throw new Error('Invalid batch id.');
  }
};

const assertValidFilename = (filename) => {
  if (
    typeof filename !== 'string'
    || !filename
    || filename !== path.basename(filename)
    || filename.includes('/')
    || filename.includes('\\')
  ) {
    throw new Error('Invalid batch filename.');
  }
};

const fetchOrThrow = async (fetchImpl, url) => {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  return response;
};

const writeFileWithoutOverwrite = async ({ bytes, destinationDir, filename, fsApi = fs }) => {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? filename : `${stem} (${suffix})${extension}`;
    const destinationPath = path.join(destinationDir, candidate);
    try {
      await fsApi.writeFile(destinationPath, bytes, { flag: 'wx' });
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
};

const downloadBatchToFolder = async ({
  batchId,
  destinationDir,
  fetchImpl = fetch,
  fsApi = fs,
  serverOrigin,
}) => {
  assertValidBatchId(batchId);
  if (typeof destinationDir !== 'string' || !path.isAbsolute(destinationDir)) {
    throw new Error('A destination folder is required.');
  }

  const batchUrl = new URL(`/api/batches/${encodeURIComponent(batchId)}`, serverOrigin);
  const batchResponse = await fetchOrThrow(fetchImpl, batchUrl);
  const batch = await batchResponse.json();
  const files = Array.isArray(batch?.files) ? batch.files : [];
  if (files.length === 0) throw new Error('The selected batch has no files.');

  const filenames = [];
  for (const file of files) {
    assertValidFilename(file?.name);
    const fileUrl = new URL(
      `/api/batches/${encodeURIComponent(batchId)}/files/${encodeURIComponent(file.name)}`,
      serverOrigin,
    );
    const fileResponse = await fetchOrThrow(fetchImpl, fileUrl);
    const bytes = Buffer.from(await fileResponse.arrayBuffer());
    filenames.push(await writeFileWithoutOverwrite({
      bytes,
      destinationDir,
      filename: file.name,
      fsApi,
    }));
  }

  return { destinationDir, filenames, savedCount: filenames.length };
};

export { downloadBatchToFolder, writeFileWithoutOverwrite };
