const CHEV = `<svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const consoleView = (): string => `
<div id="console" class="hidden">
  <header class="header">
    <span class="brand" id="brand"><svg viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M27.7736 13.8868C27.7736 21.5563 21.5563 27.7736 13.8868 27.7736C6.21733 27.7736 0 21.5563 0 13.8868C0 6.21733 6.21733 0 13.8868 0C21.5563 0 27.7736 6.21733 27.7736 13.8868Z" fill="var(--color-brand)"/><path d="M13.8868 27.7736L18.0699 35.0189H9.70373L13.8868 27.7736Z" fill="var(--color-brand)"/></svg>Convos Credits <span class="brand-suffix">Admin</span></span>
    <div class="header-right">
      <span id="identity"></span>
      <button id="lock" class="btn btn-secondary btn-sm">Lock</button>
    </div>
  </header>
  <div class="console-grid">
    <aside class="rail">
      <div class="rail-sec">
        <label for="search-value">Find account</label>
        <input id="search-value" placeholder="Account ID or wallet address">
        <button id="search-btn" class="btn btn-primary btn-block">Search</button>
        <div class="hint">Paste a wallet (0x…) or an account UUID — it detects which.</div>
      </div>
      <div class="rail-sec">
        <label for="view-mode">View</label>
        <div class="select-wrap"><select id="view-mode">
          <option value="activity">Activity feed</option>
          <option value="balance">Balance</option>
          <option value="broken">Broken subs</option>
          <option value="grantKind">Grant kind</option>
          <option value="active">Active users</option>
          <option value="dormant">Dormant users</option>
        </select>${CHEV}</div>
      </div>
      <div id="facet-group">
        <div class="rail-label">Filter activity</div>
        <span class="facet active" data-action="all">All</span>
        <span class="facet" data-action="grant">Grants</span>
        <span class="facet" data-action="adjust">Adjusts</span>
      </div>
      <div id="ctl-balance" class="mode-ctl hidden">
        <input id="bal-min" type="number" placeholder="Min credits">
        <input id="bal-max" type="number" placeholder="Max credits">
      </div>
      <div id="ctl-broken" class="mode-ctl hidden">
        <input id="broken-max" type="number" value="0" placeholder="Max balance (≤)">
      </div>
      <div id="ctl-grantKind" class="mode-ctl hidden">
        <div class="select-wrap"><select id="gk-kind">
          <option value="signup_bonus">signup_bonus</option>
          <option value="daily_refill">daily_refill</option>
          <option value="manual">manual</option>
          <option value="sub_grant">sub_grant</option>
          <option value="sub_forfeit">sub_forfeit</option>
        </select>${CHEV}</div>
      </div>
      <div id="ctl-activity" class="mode-ctl hidden">
        <input id="act-days" type="number" value="30" placeholder="Days">
      </div>
    </aside>
    <section class="center">
      <h2 id="center-title" class="center-title">Recent admin activity</h2>
      <div id="activity-wrap" class="tablewrap">
        <table id="activity-table">
          <thead><tr><th>When</th><th>Actor</th><th>Account</th><th>Action</th><th class="num">Δ</th><th>Reason</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div id="accounts-wrap" class="tablewrap hidden">
        <table id="accounts-table"><thead><tr id="accounts-head"></tr></thead><tbody></tbody></table>
      </div>
      <div id="activity-empty" class="empty hidden">No matching activity.</div>
      <button id="load-more" class="btn btn-secondary hidden">Load more</button>
    </section>
  </div>
  <div id="detail-scrim" class="detail-scrim hidden"></div>
  <aside id="detail" class="detail" aria-hidden="true">
    <button id="detail-close" class="btn btn-secondary detail-close">Close</button>
    <div id="detail-body"></div>
  </aside>
</div>`;
