export const STYLES = `
  :root {
    --brand: #283a75; --brand-strong: #1d2b58; --brand-weak: #e8e9f2;
    --brand-ring: rgba(40,58,117,.30);
    --fg: #211f1a; --fg-2: #3f3a32; --muted: #6b6455;
    --surface: #fbfaf6; --surface-2: #f2efe6; --bg: #e9e5da;
    --edge: #dcd7c9; --edge-2: #c3bca8;
    --ok: #17603d; --ok-bg: #e4eddf;
    --bad: #97231a; --bad-bg: #f7e2dc; --bad-solid: #bf2d1e; --bad-strong: #8f1f14;
    --rail-w: 260px; --header-h: 60px; --center-max: 1160px; --control-h: 36px;
    --radius-sm: 8px; --radius: 12px; --radius-lg: 16px;
    --shadow-1: 0 1px 2px rgba(33,31,26,.05), 0 1px 3px rgba(33,31,26,.07);
    --shadow-2: 0 2px 4px -1px rgba(33,31,26,.06), 0 8px 16px -4px rgba(33,31,26,.10);
    --shadow-pop: 0 12px 24px -8px rgba(33,31,26,.20), 0 32px 64px -16px rgba(33,31,26,.24);
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
  }
  * { box-sizing: border-box; }
  body {
    margin:0; font-family:var(--sans); color:var(--fg); background:var(--bg);
    -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
  }
  .hidden { display:none !important; }
  :focus-visible { outline:2px solid var(--brand); outline-offset:2px; }

  /* Login */
  #login {
    min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
    background:
      radial-gradient(120% 90% at 50% -10%, var(--surface) 0%, rgba(251,250,246,0) 60%),
      radial-gradient(80% 60% at 85% 110%, var(--brand-weak) 0%, rgba(232,233,242,0) 70%),
      var(--bg);
  }
  .login-card {
    background:var(--surface); border:1px solid var(--edge); border-radius:var(--radius-lg);
    padding:32px; width:min(400px,92vw); box-shadow:var(--shadow-2);
  }
  .login-card h1 { font-size:20px; font-weight:650; letter-spacing:-0.02em; margin:0 0 4px; }
  .login-sub { font-size:12px; color:var(--muted); margin:0 0 24px; }
  .login-card label {
    display:block; font-size:11px; font-weight:600; text-transform:uppercase;
    letter-spacing:.06em; color:var(--muted); margin-bottom:6px;
  }
  #token-input { font-family:var(--mono); font-size:14px; }
  #login-error { color:var(--bad); font-size:12px; margin-top:6px; min-height:16px; }
  #unlock { margin-top:8px; }

  /* Header */
  .header {
    position:sticky; top:0; height:var(--header-h); display:flex; align-items:center; gap:12px;
    padding:0 20px; background:rgba(251,250,246,.82); backdrop-filter:saturate(1.6) blur(10px);
    -webkit-backdrop-filter:saturate(1.6) blur(10px);
    border-bottom:1px solid var(--edge); z-index:20;
  }
  .brand { font-weight:650; font-size:14px; letter-spacing:-0.01em; cursor:pointer; user-select:none; }
  .header-right { margin-left:auto; display:flex; align-items:center; gap:14px; }
  #identity { font-size:12px; font-family:var(--mono); color:var(--muted); }

  /* Console grid */
  .console-grid { display:grid; grid-template-columns:var(--rail-w) 1fr; height:calc(100vh - var(--header-h)); }
  .rail {
    background:var(--surface); border-right:1px solid var(--edge); padding:20px 16px;
    overflow:auto; display:flex; flex-direction:column; gap:22px;
  }
  .rail-sec { display:flex; flex-direction:column; gap:8px; }
  .rail label, .rail-label {
    display:block; font-size:11px; font-weight:600; text-transform:uppercase;
    letter-spacing:.06em; color:var(--muted);
  }
  .rail input, .rail select, .login-card input {
    width:100%; min-height:var(--control-h); padding:9px 10px;
    border:1px solid var(--edge-2); border-radius:var(--radius-sm);
    font-family:var(--sans); font-size:13px; color:var(--fg); background:var(--surface);
    transition:border-color .15s, box-shadow .15s;
  }
  .rail select {
    appearance:none; -webkit-appearance:none; padding-right:30px;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--muted) 50%),
      linear-gradient(135deg, var(--muted) 50%, transparent 50%);
    background-position: calc(100% - 15px) 50%, calc(100% - 11px) 50%;
    background-size: 5px 5px, 5px 5px;
    background-repeat: no-repeat;
  }
  .rail input:focus, .rail select:focus, .login-card input:focus, .card input:focus {
    outline:none; border-color:var(--brand); box-shadow:0 0 0 3px var(--brand-ring);
  }
  input[type=number] { font-variant-numeric:tabular-nums; }
  #facet-group { display:flex; flex-wrap:wrap; gap:6px; }
  #facet-group .rail-label { flex:1 0 100%; }
  .facet {
    display:inline-flex; align-items:center; padding:6px 12px; border-radius:999px;
    border:1px solid var(--edge-2); background:var(--surface); color:var(--fg-2);
    cursor:pointer; font-size:12px; font-weight:600; user-select:none;
    transition:background .15s, color .15s, border-color .15s;
  }
  .facet:hover { background:var(--surface-2); }
  .facet.active { background:var(--brand); color:#fff; border-color:var(--brand); box-shadow:var(--shadow-1); }
  .mode-ctl { display:flex; flex-direction:column; gap:8px; }

  /* Center pane */
  .center { overflow:auto; padding:24px; display:flex; flex-direction:column; gap:16px; }
  .center > * { width:100%; max-width:var(--center-max); align-self:center; }
  .center-title { font-size:17px; font-weight:650; letter-spacing:-0.01em; margin:0; }
  .empty {
    color:var(--muted); font-size:13px; padding:28px; text-align:center;
    background:var(--surface); border:1px dashed var(--edge-2); border-radius:var(--radius);
  }
  #load-more { align-self:center; width:auto; max-width:none; min-width:180px; }

  /* Buttons */
  .btn {
    display:inline-flex; align-items:center; justify-content:center; gap:6px;
    padding:9px 16px; border:1px solid transparent; border-radius:var(--radius-sm);
    font-family:var(--sans); font-size:13px; font-weight:600; letter-spacing:.01em;
    cursor:pointer; box-shadow:var(--shadow-1);
    transition:background .15s, border-color .15s, box-shadow .15s, transform .06s, opacity .15s;
  }
  .btn:active:not(:disabled) { transform:translateY(1px); box-shadow:none; }
  .btn:disabled {
    background:var(--surface-2); color:var(--muted); border-color:var(--edge-2);
    cursor:not-allowed; box-shadow:none; transform:none; filter:none; opacity:1;
  }
  .btn-primary { background:var(--brand); color:#fff; }
  .btn-primary:hover:not(:disabled) { background:var(--brand-strong); }
  .btn-secondary { background:var(--surface); color:var(--fg-2); border-color:var(--edge-2); }
  .btn-secondary:hover:not(:disabled) { background:var(--surface-2); }
  .btn-danger { background:var(--bad-solid); color:#fff; }
  .btn-danger:hover:not(:disabled) { background:var(--bad-strong); }
  .btn-block { width:100%; }
  .btn-sm { padding:6px 12px; font-size:12px; }

  /* Badges */
  .badge {
    display:inline-flex; align-items:center; padding:3px 10px; border-radius:999px;
    border:1px solid transparent; font-size:11px; font-weight:600; letter-spacing:.02em;
  }
  .badge-yes { background:var(--ok-bg); color:var(--ok); border-color:rgba(23,96,61,.22); }
  .badge-no { background:var(--bad-bg); color:var(--bad); border-color:rgba(151,35,26,.22); }
  .badge-none { background:var(--surface-2); color:var(--muted); border-color:var(--edge-2); }

  /* Tables */
  table { width:100%; border-collapse:collapse; font-size:13px; }
  thead th {
    text-align:left; padding:10px 14px; font-size:11px; font-weight:600; text-transform:uppercase;
    letter-spacing:.06em; color:var(--muted); background:var(--surface-2);
    border-bottom:1px solid var(--edge); white-space:nowrap;
  }
  tbody td { padding:11px 14px; border-bottom:1px solid var(--edge); color:var(--fg-2); vertical-align:top; }
  tbody tr:last-child td, tbody tr:last-child th { border-bottom:none; }
  tbody th {
    text-align:left; padding:11px 14px; border-bottom:1px solid var(--edge);
    font-weight:600; color:var(--muted); white-space:nowrap; width:40%;
  }
  .num { text-align:right; white-space:nowrap; }
  .mono { font-family:var(--mono); }
  .nowrap { white-space:nowrap; }
  thead th.mono, thead th.num { font-family:var(--sans); font-variant-numeric:normal; }
  tbody td.num { font-family:var(--mono); font-variant-numeric:tabular-nums; }
  tbody td.mono { color:var(--fg); }
  .center .tablewrap {
    overflow-x:auto; background:var(--surface); border:1px solid var(--edge);
    border-radius:var(--radius); box-shadow:var(--shadow-1);
  }
  .card .tablewrap { overflow-x:auto; }
  .row-clickable { cursor:pointer; transition:background .12s; }
  .row-clickable:hover td { background:var(--surface-2); }

  /* Sparkline */
  .spark { display:flex; align-items:flex-end; gap:3px; height:64px; }
  .spark .bar {
    flex:1 1 0; min-width:3px; min-height:2px; border-radius:3px 3px 1px 1px;
    background:linear-gradient(180deg, #46589c 0%, var(--brand) 100%);
    transition:opacity .15s;
  }
  .spark .bar:hover { opacity:.65; }

  /* Cards */
  .card {
    background:var(--surface); border:1px solid var(--edge); border-radius:var(--radius);
    padding:18px; margin-bottom:14px; box-shadow:var(--shadow-1);
  }
  .card h3 {
    font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em;
    color:var(--muted); margin:0 0 12px;
  }
  .card h3.tight { margin-bottom:4px; }
  .card input {
    display:block; width:100%; padding:9px 10px; margin-bottom:8px;
    border:1px solid var(--edge-2); border-radius:var(--radius-sm);
    font-family:var(--sans); font-size:13px; color:var(--fg); background:var(--surface);
    transition:border-color .15s, box-shadow .15s;
  }
  .card .btn { min-width:160px; }
  .balance-value { font-family:var(--mono); font-variant-numeric:tabular-nums; font-size:30px; font-weight:650; letter-spacing:-0.02em; line-height:1.1; margin-bottom:4px; }
  .balance-hint { font-size:12px; color:var(--muted); }
  .sub-line { display:flex; align-items:center; gap:8px; margin-top:14px; font-size:13px; color:var(--fg-2); }
  .muted-note { color:var(--muted); font-size:13px; }

  /* Toast */
  .toast {
    position:fixed; bottom:24px; right:24px; padding:12px 18px; border-radius:var(--radius-sm);
    color:#fff; font-size:13px; font-weight:600; box-shadow:var(--shadow-2);
    opacity:0; transform:translateY(6px); transition:opacity .2s, transform .2s var(--ease);
    pointer-events:none; z-index:50;
  }
  .toast.show { opacity:1; transform:none; }
  .toast-success { background:var(--ok); } .toast-error { background:var(--bad-solid); }

  /* Detail slide-over */
  .detail-scrim {
    position:fixed; inset:0; background:rgba(33,31,26,.42);
    backdrop-filter:blur(2px); -webkit-backdrop-filter:blur(2px); z-index:30;
  }
  .detail {
    position:fixed; top:0; right:0; bottom:0; width:min(720px,64vw); background:var(--bg);
    border-left:1px solid var(--edge); box-shadow:var(--shadow-pop);
    transform:translateX(102%); transition:transform .28s var(--ease);
    z-index:40; overflow:auto; padding:24px;
  }
  .detail.open { transform:none; }
  .detail-close { float:right; }
  .detail-title { font-size:17px; font-weight:650; letter-spacing:-0.01em; margin:0 0 16px; }

  /* Responsive */
  @media (max-width:768px) {
    .console-grid { grid-template-columns:1fr; height:auto; }
    .rail { border-right:none; border-bottom:1px solid var(--edge); }
    .center { padding:16px; }
    .detail { width:100vw; padding:16px; }
    thead th { padding:8px 10px; }
    tbody td, tbody th { padding:9px 10px; font-size:12px; }
  }
  @media (pointer:coarse) {
    .btn,.facet { min-height:44px; }
    tbody td, tbody th { padding-top:14px; padding-bottom:14px; line-height:16px; }
    .rail input, .rail select, .card input { min-height:44px; font-size:16px; }
  }
  @media (prefers-reduced-motion:reduce) {
    * { transition:none !important; }
    .detail { transition:none; }
  }
`;
