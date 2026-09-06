const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const version = new URLSearchParams(window.location.search).get('version') || '';
const normalizedVersion = VERSION_PATTERN.test(version) ? version : '';

const detail = document.getElementById('updateDetail');
const laterButton = document.getElementById('laterButton');
const restartButton = document.getElementById('restartButton');

detail.textContent = normalizedVersion
  ? `Restart now to update to version ${normalizedVersion}.`
  : 'Restart now to finish the update.';

laterButton.addEventListener('click', () => {
  window.snapOverLanUpdateDialog.chooseAction('later');
});

restartButton.addEventListener('click', () => {
  window.snapOverLanUpdateDialog.chooseAction('restart');
});

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  window.snapOverLanUpdateDialog.chooseAction('later');
});

restartButton.focus();
