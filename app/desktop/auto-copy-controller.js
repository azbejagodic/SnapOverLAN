import { promises as fs } from 'fs';
import { copyFirstUploadedImage } from '../auto-copy.js';

const createAutoCopyController = ({
  clipboard,
  getEnabled,
  isOwnedServerProcess,
  nativeImage,
  sendResult,
  setEnabled,
}) => {
  const fileExists = async (filePath) => {
    try { return (await fs.stat(filePath)).isFile(); } catch { return false; }
  };

  const log = (stage, details = {}) => {
    console.info(`[auto-copy] ${stage}`, details);
  };

  const sendSettingResponse = (serverProcess, requestId, response) => {
    if (!isOwnedServerProcess(serverProcess)
      || !serverProcess.connected
      || typeof requestId !== 'string') {
      return;
    }
    try {
      serverProcess.send({
        type: 'snapoverlan:auto-copy-response',
        requestId,
        ...response,
      });
    } catch (error) {
      console.warn('Could not send the auto-copy setting response:', error);
    }
  };

  const handleSettingRequest = async (serverProcess, message) => {
    if (message?.type !== 'snapoverlan:auto-copy-request'
      || typeof message.requestId !== 'string'
      || !['get', 'set'].includes(message.operation)) {
      return false;
    }
    try {
      if (message.operation === 'set') {
        if (typeof message.enabled !== 'boolean') {
          throw new Error('Expected a boolean auto-copy setting.');
        }
        await setEnabled(message.enabled);
      }
      sendSettingResponse(serverProcess, message.requestId, { enabled: getEnabled() });
    } catch (error) {
      sendSettingResponse(serverProcess, message.requestId, {
        error: error.message || 'Could not update the auto-copy setting.',
      });
    }
    return true;
  };

  const handleServerMessage = async (serverProcess, message) => {
    if (!isOwnedServerProcess(serverProcess)) return;
    if (await handleSettingRequest(serverProcess, message)) return;

    const result = await copyFirstUploadedImage({
      message,
      enabled: getEnabled(),
      fileExists,
      createImageFromPath: (filePath) => nativeImage.createFromPath(filePath),
      createImageFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer),
      writeImage: (image) => clipboard.writeImage(image),
      readImage: () => clipboard.readImage(),
      onDiagnostic: log,
    });
    if (result.status === 'failed') {
      console.warn(`Could not automatically copy ${result.filename}:`, result.error);
    }
    sendResult(result);
  };

  return { handleServerMessage, log };
};

export { createAutoCopyController };
