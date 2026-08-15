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
  batchesButton,
  batchesList,
  clearButton,
  clearMessage,
  closeButton,
  fetchJson,
  formatBytes,
  onBatchesChanged,
  onLayoutChanged,
  panel,
  picturesPanel,
  retentionSelect,
  saveButton,
  setMessage,
}) => {
  let batches = [];
  let refreshPromise = null;
  let savedRetentionValue = null;

  const normalizeRetentionValue = (value) => (value ? String(value) : '');

  const updateSaveButton = () => {
    if (!retentionSelect || !saveButton) return;
    saveButton.disabled = savedRetentionValue !== null
      && retentionSelect.value === savedRetentionValue;
  };

  const render = () => {
    if (!batchesList) return;
    batchesList.textContent = '';
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
    if (!panel || panel.hidden) return;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const [batchData, settings] = await Promise.all([
          fetchJson('/api/batches'),
          fetchJson('/api/storage-settings'),
        ]);
        batches = Array.isArray(batchData.batches) ? batchData.batches : [];
        if (retentionSelect) {
          const loadedValue = normalizeRetentionValue(settings.retentionDays);
          if (savedRetentionValue === null || retentionSelect.value === savedRetentionValue) {
            retentionSelect.value = loadedValue;
          }
          savedRetentionValue = loadedValue;
          updateSaveButton();
        }
        render();
      } catch (error) {
        setMessage(error.message || 'Could not load batches.');
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  };

  const refreshPicturesAndHistory = async () => {
    await onBatchesChanged();
    await load();
    clearMessage();
  };

  async function selectBatch(id) {
    try {
      await fetchJson(`/api/batches/${encodeURIComponent(id)}/select`, { method: 'POST' });
      await refreshPicturesAndHistory();
    } catch (error) {
      setMessage(error.message || 'Could not select batch.');
    }
  }

  async function deleteBatch(batch) {
    if (!window.confirm(`Delete the batch from ${formatBatchDate(batch.createdAt)}?`)) return;
    try {
      await fetchJson(`/api/batches/${encodeURIComponent(batch.id)}`, { method: 'DELETE' });
      await refreshPicturesAndHistory();
    } catch (error) {
      setMessage(error.message || 'Could not delete batch.');
    }
  }

  const clearAll = async () => {
    if (!window.confirm('Clear all saved batches? This cannot be undone.')) return;
    try {
      await fetchJson('/api/batches', { method: 'DELETE' });
      await refreshPicturesAndHistory();
    } catch (error) {
      setMessage(error.message || 'Could not clear batches.');
    }
  };

  const saveRetention = async () => {
    try {
      const value = retentionSelect?.value || '';
      const settings = await fetchJson('/api/storage-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionDays: value ? Number(value) : null }),
      });
      savedRetentionValue = normalizeRetentionValue(settings.retentionDays);
      updateSaveButton();
      await load();
      clearMessage();
    } catch (error) {
      setMessage(error.message || 'Could not save retention setting.');
    }
  };

  const setOpen = (isOpen) => {
    if (!panel) return;
    panel.hidden = !isOpen;
    picturesPanel?.classList.toggle('history-open', isOpen);
    batchesButton?.classList.toggle('active', isOpen);
    onLayoutChanged();
    if (isOpen) {
      load();
      closeButton?.focus();
    } else {
      batchesButton?.focus();
    }
  };

  const getCurrentBatchZipName = async () => {
    let currentBatch = batches.find((batch) => batch.current);
    if (!currentBatch) {
      try {
        const batchData = await fetchJson('/api/batches');
        batches = Array.isArray(batchData.batches) ? batchData.batches : [];
        currentBatch = batches.find((batch) => batch.current);
        if (batches.length) render();
      } catch {
        // Fall back to the current local time if metadata is unavailable.
      }
    }
    return formatBatchZipName(currentBatch?.createdAt);
  };

  const bind = () => {
    batchesButton?.addEventListener('click', () => setOpen(true));
    closeButton?.addEventListener('click', () => setOpen(false));
    saveButton?.addEventListener('click', saveRetention);
    retentionSelect?.addEventListener('change', updateSaveButton);
    clearButton?.addEventListener('click', clearAll);
  };

  return { bind, getCurrentBatchZipName, load };
};

export { createBatchHistory };
