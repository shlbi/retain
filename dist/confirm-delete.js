const dialog = document.getElementById('delete-confirm-dialog');
const title = document.getElementById('delete-confirm-title');
const description = document.getElementById('delete-confirm-description');
const cancel = document.getElementById('delete-confirm-cancel');
const confirm = document.getElementById('delete-confirm-submit');
let resolveDecision = null;

function finish(approved) {
  if (!resolveDecision) return;
  const resolve = resolveDecision;
  resolveDecision = null;
  dialog.close();
  title.textContent = description.textContent = confirm.textContent = '';
  resolve(approved);
}

cancel.addEventListener('click',() => finish(false));
confirm.addEventListener('click',() => finish(true));
dialog.addEventListener('cancel',event => {
  event.preventDefault();
  finish(false);
});

/** Show the saved target and consequences before an admin can confirm a deletion. */
export function confirmDelete(details) {
  if (resolveDecision) return Promise.resolve(false);
  title.textContent = details.title;
  description.textContent = details.description;
  confirm.textContent = details.action;
  return new Promise(resolve => {
    resolveDecision = resolve;
    dialog.showModal();
    cancel.focus();
  });
}

/** Invalidate pending confirmation when the admin session or role changes. */
export function closeDeleteConfirmation() { finish(false); }
