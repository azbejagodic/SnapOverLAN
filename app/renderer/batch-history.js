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

const formatBatchZipName = (batchTimestamp) => {
  const date = batchTimestamp ? new Date(batchTimestamp) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = [
    safeDate.getFullYear(),
    String(safeDate.getMonth() + 1).padStart(2, '0'),
    String(safeDate.getDate()).padStart(2, '0'),
    String(safeDate.getHours()).padStart(2, '0'),
    String(safeDate.getMinutes()).padStart(2, '0'),
    String(safeDate.getSeconds()).padStart(2, '0'),
  ];
  return `snapoverlan_${parts[0]}-${parts[1]}-${parts[2]}_${parts[3]}-${parts[4]}-${parts[5]}_batch.zip`;
};

const createBatchHistory = ({
  batchesList,
  clearButton,
  clearMessage,
  downloadButton,
  fetchJson,
  formatBytes,
  serverUrl,
  setMessage,
}) => {
  let batches = [];
  let refreshPromise = null;

  const getCurrentBatch = () => batches.find((batch) => batch.current);

  const updateDownloadButton = () => {
    if (!downloadButton) return;
    const currentBatch = getCurrentBatch();
    downloadButton.disabled = !currentBatch || currentBatch.fileCount === 0;
  };

  const render = () => {
    if (!batchesList) return;
    batchesList.textContent = '';
    updateDownloadButton();

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

  const load = async () => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const batchData = await fetchJson('/api/batches');
        batches = Array.isArray(batchData.batches) ? batchData.batches : [];
        render();
      } catch (error) {
        setMessage(error.message || 'Could not load batches.');
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  };

  const refresh = async () => {
    await load();
    clearMessage();
  };

  async function selectBatch(id) {
    try {
      await fetchJson(`/api/batches/${encodeURIComponent(id)}/select`, { method: 'POST' });
      await refresh();
    } catch (error) {
      setMessage(error.message || 'Could not select batch.');
    }
  }

  async function deleteBatch(batch) {
    if (!window.confirm(`Delete the batch from ${formatBatchDate(batch.createdAt)}?`)) return;
    try {
      await fetchJson(`/api/batches/${encodeURIComponent(batch.id)}`, { method: 'DELETE' });
      await refresh();
    } catch (error) {
      setMessage(error.message || 'Could not delete batch.');
    }
  }

  const clearAll = async () => {
    if (!window.confirm('Clear all saved batches? This cannot be undone.')) return;
    try {
      await fetchJson('/api/batches', { method: 'DELETE' });
      await refresh();
    } catch (error) {
      setMessage(error.message || 'Could not clear batches.');
    }
  };

  const downloadCurrentBatch = async () => {
    const currentBatch = getCurrentBatch();
    if (!currentBatch || currentBatch.fileCount === 0 || !downloadButton) return;

    downloadButton.disabled = true;
    downloadButton.textContent = 'Downloading...';
    try {
      const response = await fetch(serverUrl('/api/latest/download'));
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = formatBatchZipName(currentBatch.createdAt);
      link.click();
      URL.revokeObjectURL(objectUrl);
      clearMessage();
    } catch (error) {
      setMessage(error.message || 'Could not download the current batch.');
    } finally {
      downloadButton.textContent = 'Download current batch';
      updateDownloadButton();
    }
  };

  const bind = () => {
    downloadButton?.addEventListener('click', downloadCurrentBatch);
    clearButton?.addEventListener('click', clearAll);
  };

  return { bind, load };
};

export { createBatchHistory };
