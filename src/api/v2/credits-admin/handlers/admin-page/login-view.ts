export const loginView = (): string => `
<div id="login">
  <div class="login-card">
    <h1><svg viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M27.7736 13.8868C27.7736 21.5563 21.5563 27.7736 13.8868 27.7736C6.21733 27.7736 0 21.5563 0 13.8868C0 6.21733 6.21733 0 13.8868 0C21.5563 0 27.7736 6.21733 27.7736 13.8868Z" fill="var(--color-brand)"/><path d="M13.8868 27.7736L18.0699 35.0189H9.70373L13.8868 27.7736Z" fill="var(--color-brand)"/></svg>Convos Credits Admin</h1>
    <div class="login-sub">Restricted — internal operations</div>
    <label for="token-input">Admin token</label>
    <input id="token-input" type="password" placeholder="Paste CREDITS_ADMIN_API_TOKEN" autocomplete="off">
    <div id="login-error"></div>
    <button id="unlock" class="btn btn-primary btn-block">Unlock</button>
  </div>
</div>`;
