export const consoleView = (): string => `
<div id="console" class="hidden">
  <header class="header">
    <span class="brand" id="brand">💳 Credits Admin</span>
    <div class="header-right">
      <span id="identity"></span>
      <button id="lock" class="btn btn-secondary" style="padding:6px 12px">Lock</button>
    </div>
  </header>
  <div class="console-grid">
    <aside class="rail">
      <div>
        <label for="search-value">Find account</label>
        <select id="search-key"><option value="accountId">accountId</option><option value="wallet">wallet</option></select>
        <input id="search-value" placeholder="accountId or wallet">
        <button id="search-btn" class="btn btn-primary" style="width:100%;margin-top:8px">Search</button>
      </div>
      <div>
        <label for="view-mode">View</label>
        <select id="view-mode">
          <option value="activity">Activity feed</option>
          <option value="balance">Balance</option>
          <option value="broken">Broken subs</option>
          <option value="grantKind">Grant kind</option>
          <option value="active">Active users</option>
          <option value="dormant">Dormant users</option>
        </select>
      </div>
      <div id="facet-group">
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Filter activity</div>
        <span class="facet active" data-action="all">All</span>
        <span class="facet" data-action="grant">Grants</span>
        <span class="facet" data-action="adjust">Adjusts</span>
      </div>
      <div id="ctl-balance" class="mode-ctl hidden">
        <input id="bal-min" type="number" placeholder="min credits">
        <input id="bal-max" type="number" placeholder="max credits">
        <select id="bal-sort"><option value="desc">High → low</option><option value="asc">Low → high</option></select>
      </div>
      <div id="ctl-broken" class="mode-ctl hidden">
        <input id="broken-max" type="number" value="0" placeholder="max balance (≤)">
      </div>
      <div id="ctl-grantKind" class="mode-ctl hidden">
        <select id="gk-kind">
          <option value="signup_bonus">signup_bonus</option>
          <option value="daily_refill">daily_refill</option>
          <option value="manual">manual</option>
          <option value="sub_grant">sub_grant</option>
          <option value="sub_forfeit">sub_forfeit</option>
        </select>
      </div>
      <div id="ctl-activity" class="mode-ctl hidden">
        <input id="act-days" type="number" value="30" placeholder="days">
      </div>
    </aside>
    <section class="center">
      <h2 id="center-title" style="font-size:16px;margin:0 0 12px">Recent admin activity</h2>
      <div class="tablewrap">
        <table id="activity-table">
          <thead><tr><th>When</th><th>Actor</th><th>Account</th><th>Action</th><th>Δ</th><th>Reason</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div id="accounts-wrap" class="tablewrap hidden">
        <table id="accounts-table"><thead><tr id="accounts-head"></tr></thead><tbody></tbody></table>
      </div>
      <div id="activity-empty" class="hidden" style="color:var(--muted);padding:12px">No matching activity.</div>
      <button id="load-more" class="btn btn-secondary hidden" style="margin-top:12px">Load more</button>
    </section>
  </div>
  <div id="detail-scrim" class="detail-scrim hidden"></div>
  <aside id="detail" class="detail" aria-hidden="true">
    <button id="detail-close" class="btn btn-secondary detail-close">Close</button>
    <div id="detail-body"></div>
  </aside>
</div>`;
