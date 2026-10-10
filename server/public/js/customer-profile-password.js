(function () {
  'use strict';
  const get = id => document.getElementById(id);
  const form = get('customerPasswordForm');
  if (!form) return;
  const current = get('customerCurrentPassword'), password = get('customerNewPassword'), confirm = get('customerConfirmPassword');
  const button = get('customerChangePassword'), alertBox = get('customerPasswordAlert'), show = get('customerShowPasswords');
  const openButton = get('openPasswordBtn');
  if (openButton) openButton.addEventListener('click', () => {
    current.focus({ preventScroll: true });
    get('customerPasswordSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  let saving = false;
  function message(text, success = false) {
    alertBox.textContent = text; alertBox.className = 'alert alert-' + (success ? 'success' : 'danger'); alertBox.focus();
  }
  function invalid(input,text) { message(text); input.setAttribute('aria-invalid','true'); input.focus(); }
  [current,password,confirm].forEach(input => input.addEventListener('input', () => input.removeAttribute('aria-invalid')));
  show.addEventListener('change', () => [current,password,confirm].forEach(input => { input.type = show.checked ? 'text' : 'password'; }));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    if (!current.value) return invalid(current,'Enter your current password.');
    const value = password.value;
    if (value.length < 8 || value.length > 30 || !/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/\d/.test(value) || !/[^A-Za-z0-9]/.test(value)) return invalid(password,'Use 8–30 characters with uppercase, lowercase, number, and special characters.');
    if (current.value === value) return invalid(password,'Choose a new password different from your current password.');
    if (confirm.value !== value) return invalid(confirm,'The new passwords do not match.');
    saving = true; button.disabled = true; button.textContent = 'Changing password…'; form.setAttribute('aria-busy','true');
    [current,password,confirm].forEach(input => { input.readOnly = true; });
    try {
      const response = await fetch('/api/users/me/password', { method:'PATCH', credentials:'same-origin', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ currentPassword:current.value, newPassword:value }) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error(response.status === 401 ? 'Your session expired. Sign in again to change your password.' : data?.error || 'Your password could not be changed. Please try again.');
      form.reset(); message(data.message || 'Password changed. Please sign in again.',true);
      [current,password,confirm].forEach(input => { input.type = 'password'; });
      button.textContent = 'Password changed';
      window.setTimeout(() => window.location.assign('/login'),1200);
    } catch (error) {
      message(error.message || 'Unable to reach the server. Please try again.');
      saving = false; button.disabled = false; button.textContent = 'Change password';
      [current,password,confirm].forEach(input => { input.readOnly = false; });
    } finally { form.removeAttribute('aria-busy'); }
  });
})();
