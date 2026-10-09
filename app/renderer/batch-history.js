const batchErrorMessages = new Map([
  ['Desktop download is unavailable.', "Downloading isn't available right now. Restart SnapOverLAN and try again."],
  ['Invalid batch id.', "Couldn't find this upload. Refresh and try again."],
  ['Invalid batch filename.', "Couldn't find a valid file in this upload."],
  ['A destination folder is required.', "Couldn't find a destination for these photos. Check your Downloads folder and try again."],
  ['The selected batch has no files.', 'This upload has no photos to download.'],
  ['Batch not found.', 'This upload is no longer available. Refresh the list.'],
  ['No current batch.', 'There is no current upload to download.'],
  ['Invalid filename.', "A file in this upload couldn't be accessed."],
  ['Invalid batch path.', "This saved upload couldn't be accessed. Try again."],
  ['Storage request failed.', "Couldn't access saved uploads right now. Try again."],
  ['Download timed out. Please try again.', 'Download timed out. Please try again.'],
]);

const formatBatchDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const createBatchHistory = ({
  batchesList,
  clearButton,
  clearMessage,
  downloadButton,
  fetchJson,
  formatBytes,
  setMessage,
}) => {
  let batches = [];
  let refreshPromise = null;
  let available = false;
  let availabilityRevision = 0;

  const showError = (error, fallback) => {
    console.error('Saved upload operation failed:', error);
    // Electron prefixes errors crossing IPC; only map recognized messages.
    const message = typeof error?.message === 'string'
      ? error.message.replace(/^Error invoking remote method '(?:batch:download|server:request)': (?:Error: )?/, '') : '';
    setMessage(batchErrorMessages.get(message) || (/^Download failed \(\d{3}\)\.$/.test(message)
      ? "Couldn't download a photo from this upload. Try again." : fallback));
  };

  const getCurrentBatch = () => batches.find((batch) => batch.current);

  const updateDownloadButton = () => {
    if (!downloadButton) return;
    const currentBatch = getCurrentBatch();
    downloadButton.disabled = !available || !currentBatch || currentBatch.fileCount === 0;
  };

  const render = () => {
    if (!batchesList) return;
    batchesList.textContent = '';
    updateDownloadButton();
    if (!available) return;

    if (!batches.length) {
      const empty = document.createElement('p');
      empty.className = 'batches-empty';
      empty.textContent = 'No saved batches.';
      batchesList.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const batch of batches) {
      const item = document.createElement('article');
      item.className = batch.current ? 'batch-item current' : 'batch-item';
      const details = document.createElement('div');
      details.className = 'batch-details';
      const title = document.createElement('strong');
      title.textContent = formatBatchDate(batch.createdAt);
      const meta = document.createElement('span');
      const countLabel = batch.fileCount === 1 ? '1 file' : `${batch.fileCount} files`;
      meta.textContent = `${countLabel} · ${formatBytes(batch.totalSize)}${batch.current ? ' · Current' : ''}`;
      details.append(title, meta);

      const actions = document.createElement('div');
      actions.className = 'batch-actions';
      const selectButton = document.createElement('button');
      selectButton.className = 'batch-button';
      selectButton.type = 'button';
      selectButton.textContent = batch.current ? 'Selected' : 'Select';
      selectButton.disabled = batch.current;
      selectButton.addEventListener('click', () => selectBatch(batch.id));
      const deleteButton = document.createElement('button');
      deleteButton.className = 'batch-button danger';
      deleteButton.type = 'button';
      deleteButton.textContent = 'Delete';
      deleteButton.addEventListener('click', () => deleteBatch(batch));
      actions.append(selectButton, deleteButton);
      item.append(details, actions);
      fragment.appendChild(item);
    }
    batchesList.appendChild(fragment);
  };

  const setAvailable = (value) => {
    if (available !== value) availabilityRevision += 1;
    available = value;
    if (clearButton) clearButton.disabled = !available;
    if (!available) {
      batches = [];
      render();
    }
  };

  const load = async () => {
    if (!available) return;
    if (refreshPromise) return refreshPromise;
    const revision = availabilityRevision;
    refreshPromise = (async () => {
      try {
        const batchData = await fetchJson('/api/batches');
        if (!available || revision !== availabilityRevision) return;
        batches = Array.isArray(batchData.batches) ? batchData.batches : [];
        render();
        return true;
      } catch (error) {
        showError(error, "Couldn't load saved uploads. Try Refresh.");
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  };

  const refresh = async () => {
    if (await load()) clearMessage();
  };

  async function selectBatch(id) {
    if (!available) return;
    try {
      await fetchJson(`/api/batches/${encodeURIComponent(id)}/select`, { method: 'POST' });
      await refresh();
    } catch (error) {
      showError(error, "Couldn't select this upload. Try again.");
    }
  }

  async function deleteBatch(batch) {
    if (!available) return;
    if (!window.confirm(`Delete the batch from ${formatBatchDate(batch.createdAt)}?`) || !available) return;
    try {
      await fetchJson(`/api/batches/${encodeURIComponent(batch.id)}`, { method: 'DELETE' });
      await refresh();
    } catch (error) {
      showError(error, "Couldn't delete this upload. Try again.");
    }
  }

  const clearAll = async () => {
    if (!available) return;
    if (!window.confirm('Clear all saved batches? This cannot be undone.') || !available) return;
    try {
      await fetchJson('/api/batches', { method: 'DELETE' });
      await refresh();
    } catch (error) {
      showError(error, "Couldn't clear saved uploads. Try again.");
    }
  };

  const downloadCurrentBatch = async () => {
    const currentBatch = getCurrentBatch();
    if (!available || !currentBatch || currentBatch.fileCount === 0 || !downloadButton) return;

    downloadButton.disabled = true;
    downloadButton.textContent = 'Downloading...';
    try {
      if (!window.snapOverLAN?.downloadBatch) throw new Error('Desktop download is unavailable.');
      await window.snapOverLAN.downloadBatch(currentBatch.id);
      clearMessage();
    } catch (error) {
      showError(error, "Couldn't download the selected upload. Try again.");
    } finally {
      downloadButton.textContent = 'Download';
      updateDownloadButton();
    }
  };

  const bind = () => {
    setAvailable(false);
    downloadButton?.addEventListener('click', downloadCurrentBatch);
    clearButton?.addEventListener('click', clearAll);
  };

  return { bind, load, setAvailable };
};

export { createBatchHistory };
