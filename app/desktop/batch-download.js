import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

const BATCH_ID_PATTERN = /^batch_[a-zA-Z0-9_-]+$/;
const DOWNLOAD_REQUEST_TIMEOUT_MS = 30_000;

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

const fetchOrThrow = async (fetchImpl, url, readBody) => {
  const signal = AbortSignal.timeout(DOWNLOAD_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`Download failed (${response.status}).`);
    // The request deadline also covers reading the response body.
    return await readBody(response);
  } catch (error) {
    if (signal.aborted) throw new Error('Download timed out. Please try again.');
    throw error;
  }
};

const writeFileWithoutOverwrite = async ({ bytes, destinationDir, filename, fsApi = fs }) => {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  const temporaryPath = path.join(destinationDir, `.snapoverlan-${randomUUID()}.tmp`);
  const temporaryFile = await fsApi.open(temporaryPath, 'wx');
  try {
    await temporaryFile.writeFile(bytes);
    await temporaryFile.close();
    for (let suffix = 0; ; suffix += 1) {
      const candidate = suffix === 0 ? filename : `${stem} (${suffix})${extension}`;
      const destinationPath = path.join(destinationDir, candidate);
      try {
        // rename() can overwrite a racing destination. A hard link publishes
        // the complete file atomically and fails if the name is already taken.
        await fsApi.link(temporaryPath, destinationPath);
        return candidate;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  } finally {
    await temporaryFile.close().catch(() => {});
    await fsApi.rm(temporaryPath, { force: true }).catch(() => {});
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
  const batch = await fetchOrThrow(fetchImpl, batchUrl, (response) => response.json());
  const files = Array.isArray(batch?.files) ? batch.files : [];
  if (files.length === 0) throw new Error('The selected batch has no files.');

  const filenames = [];
  for (const file of files) {
    assertValidFilename(file?.name);
    const fileUrl = new URL(
      `/api/batches/${encodeURIComponent(batchId)}/files/${encodeURIComponent(file.name)}`,
      serverOrigin,
    );
    const bytes = Buffer.from(await fetchOrThrow(fetchImpl, fileUrl, (response) => response.arrayBuffer()));
    filenames.push(await writeFileWithoutOverwrite({
      bytes,
      destinationDir,
      filename: file.name,
      fsApi,
    }));
  }

  return { destinationDir, filenames, savedCount: filenames.length };
};

export { downloadBatchToFolder };
