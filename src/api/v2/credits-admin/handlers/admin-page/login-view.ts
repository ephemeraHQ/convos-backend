export const loginView = (): string => `
<div id="login">
  <div class="login-card">
    <h1>💳 Credits Admin</h1>
    <label for="token-input">Admin token</label>
    <input id="token-input" type="password" placeholder="paste CREDITS_ADMIN_API_TOKEN" autocomplete="off">
    <div id="login-error"></div>
    <button id="unlock" class="btn btn-primary" style="width:100%;margin-top:14px">Unlock</button>
  </div>
</div>`;
