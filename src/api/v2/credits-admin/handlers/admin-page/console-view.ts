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
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Filter activity</div>
        <span class="facet active" data-action="all">All</span>
        <span class="facet" data-action="grant">Grants</span>
        <span class="facet" data-action="adjust">Adjusts</span>
      </div>
    </aside>
    <section class="center">
      <h2 style="font-size:16px;margin:0 0 12px">Recent admin activity</h2>
      <div class="tablewrap">
        <table id="activity-table">
          <thead><tr><th>When</th><th>Actor</th><th>Account</th><th>Action</th><th>Δ</th><th>Reason</th></tr></thead>
          <tbody></tbody>
        </table>
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
