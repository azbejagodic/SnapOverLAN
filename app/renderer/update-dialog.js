const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const version = new URLSearchParams(window.location.search).get('version') || '';
const normalizedVersion = VERSION_PATTERN.test(version) ? version : '';

const message = document.getElementById('updateMessage');
const laterButton = document.getElementById('laterButton');
const restartButton = document.getElementById('restartButton');

message.textContent = normalizedVersion
  ? `SnapOverLAN ${normalizedVersion} is ready to install.`
  : 'A SnapOverLAN update is ready to install.';

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

laterButton.focus();
