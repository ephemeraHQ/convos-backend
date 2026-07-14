export const STYLES = `
  :root {
    --brand: #0071e3; --fg: #1d1d1f; --muted: #6e6e73; --surface: #fff;
    --bg: #f5f5f7; --edge: #ececec; --ok: #14752a; --bad: #a3151f;
    --rail-w: 260px; --header-h: 56px; --radius: 12px;
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
  }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:var(--fg); background:var(--bg); }
  .hidden { display:none !important; }

  /* Login */
  #login { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
  .login-card { background:var(--surface); border-radius:var(--radius); padding:28px; width:min(380px,92vw); box-shadow:0 1px 3px rgba(0,0,0,.1); }
  .login-card h1 { font-size:20px; margin:0 0 16px; }
  .login-card input { width:100%; padding:12px; border:1px solid #d2d2d7; border-radius:8px; font-size:15px; }
  #login-error { color:var(--bad); font-size:13px; margin-top:10px; min-height:16px; }

  /* Header */
  .header { position:sticky; top:0; height:var(--header-h); display:flex; align-items:center; gap:12px; padding:0 16px; background:var(--surface); border-bottom:1px solid var(--edge); z-index:20; }
  .brand { font-weight:700; cursor:pointer; }
  .header-right { margin-left:auto; display:flex; align-items:center; gap:12px; }
  #identity { font-size:13px; color:var(--muted); }

  /* Console grid */
  .console-grid { display:grid; grid-template-columns:var(--rail-w) 1fr; height:calc(100vh - var(--header-h)); }
  .rail { border-right:1px solid var(--edge); padding:16px; overflow:auto; display:flex; flex-direction:column; gap:14px; }
  .center { overflow:auto; padding:16px; }
  .facet { display:inline-block; padding:6px 12px; border-radius:999px; border:1px solid var(--edge); cursor:pointer; font-size:13px; background:var(--surface); }
  .facet.active { background:var(--brand); color:#fff; border-color:var(--brand); }

  /* Buttons / badges / tables / toast / spark — reuse from prior page */
  .btn { padding:10px 16px; border:none; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; }
  .btn-primary { background:var(--brand); color:#fff; } .btn-danger { background:#d70015; color:#fff; }
  .btn-secondary { background:#e8e8ed; color:var(--fg); }
  .badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:600; }
  .badge-yes { background:#d1f0d6; color:var(--ok); } .badge-no { background:#f7d6d6; color:var(--bad); }
  .badge-none { background:#e8e8ed; color:var(--muted); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px; border-bottom:1px solid var(--edge); }
  .tablewrap { overflow-x:auto; }
  .row-clickable { cursor:pointer; } .row-clickable:hover { background:var(--bg); }
  .spark { display:flex; align-items:flex-end; gap:2px; height:56px; }
  .spark .bar { flex:1 1 0; min-width:3px; min-height:2px; background:var(--brand); border-radius:2px 2px 0 0; }
  .card { background:var(--surface); border-radius:var(--radius); padding:16px; margin-bottom:14px; }
  .toast { position:fixed; bottom:24px; right:24px; padding:12px 18px; border-radius:8px; color:#fff; opacity:0; transition:opacity .2s; pointer-events:none; }
  .toast.show { opacity:1; } .toast-success { background:var(--ok); } .toast-error { background:var(--bad); }

  /* Detail slide-over */
  .detail-scrim { position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:30; }
  .detail { position:fixed; top:0; right:0; bottom:0; width:min(720px,64vw); background:var(--surface); box-shadow:-2px 0 12px rgba(0,0,0,.15); transform:translateX(102%); transition:transform .24s var(--ease); z-index:40; overflow:auto; padding:20px; }
  .detail.open { transform:none; }
  .detail-close { float:right; }

  /* Responsive */
  @media (max-width:768px) {
    .console-grid { grid-template-columns:1fr; }
    .rail { border-right:none; border-bottom:1px solid var(--edge); }
    .detail { width:100vw; }
    th,td { padding:6px; font-size:12px; }
  }
  @media (pointer:coarse) { .btn,.facet,.row-clickable { min-height:44px; } }
  @media (prefers-reduced-motion:reduce) { .detail { transition:none; } }
`;
