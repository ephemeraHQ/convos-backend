export const STYLES = `
:root{
  --color-brand:#FC4F37; --color-brand-hover:#D9412D;
  --color-brand-strong:#CE3A23; --color-brand-strong-hover:#B5331D;
  --brand-ring:color-mix(in srgb, #FC4F37 22%, transparent);
  --fg:#000; --fg-2:#666; --fg-3:#B2B2B2; --fg-muted:#6E6E6E; --fg-inv:#fff;
  --surface:#fff; --surface-muted:#F5F5F5; --surface-hover:#FAFAFA;
  --edge:#EBEBEB; --edge-2:#F0F0F0;
  --ok:#16A34A; --ok-bg:#F0FDF4; --ok-fg:#065F46;
  --bad:#DC2626; --bad-bg:#FEE2E2; --bad-fg:#991B1B;
  --none-bg:#E5E7EB; --none-fg:#4B5563;
  --rail-w:240px; --header-h:53px; --center-max:1160px; --control-h:38px;
  --radius-sm:6px; --radius:8px; --radius-lg:12px; --radius-full:999px;
  --shadow-pop:0 10px 32px rgba(0,0,0,.14), 0 2px 6px rgba(0,0,0,.06);
  --shadow-detail:-18px 0 56px rgba(0,0,0,.16);
  --shadow-modal:0 24px 68px rgba(0,0,0,.28), 0 4px 14px rgba(0,0,0,.12);
  --shadow-toast:0 8px 24px rgba(0,0,0,.18);
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;
  --mono:"SF Mono",Monaco,ui-monospace,Menlo,"Courier New",monospace;
  --ease:cubic-bezier(0.23,1,0.32,1);
}
*{box-sizing:border-box;}
body{margin:0;font-family:var(--sans);color:var(--fg);background:var(--surface-muted);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;}
.hidden{display:none !important;}
:focus-visible{outline:2px solid var(--color-brand);outline-offset:2px;}

/* Login */
#login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
.login-card{width:100%;max-width:360px;background:var(--surface);border:1px solid var(--edge);border-radius:var(--radius-lg);padding:28px 24px;}
.login-card h1{display:flex;align-items:center;gap:9px;margin:0 0 4px;font-size:18px;font-weight:700;letter-spacing:-0.3px;}
.login-card h1 svg{width:20px;height:26px;display:block;}
.login-sub{font-size:12px;color:var(--fg-2);margin-bottom:20px;}
.login-card label{display:block;font-size:11px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:var(--fg-2);margin-bottom:8px;}
#token-input{width:100%;background:var(--surface);border:1px solid var(--edge);border-radius:var(--radius);padding:10px 14px;font-family:var(--mono);font-size:13px;color:var(--fg);}
#token-input::placeholder{color:var(--fg-3);font-family:var(--sans);}
#token-input:focus{outline:none;border-color:var(--fg-3);}
#login-error{min-height:18px;margin:8px 0;font-size:12px;color:var(--bad);}

/* Header */
.header{height:var(--header-h);background:var(--surface);border-bottom:1px solid var(--edge);display:flex;align-items:center;justify-content:space-between;padding:0 20px;position:sticky;top:0;z-index:10;}
.brand{display:flex;align-items:center;gap:9px;cursor:pointer;font-size:16px;font-weight:700;letter-spacing:-0.3px;}
.brand svg{width:22px;height:28px;display:block;}
.brand .brand-suffix{font-weight:400;color:var(--fg-2);}
.header-right{display:flex;align-items:center;gap:14px;}
#identity{font-size:12px;color:var(--fg-2);}

/* Console grid + rail */
.console-grid{display:grid;grid-template-columns:var(--rail-w) 1fr;min-height:calc(100vh - var(--header-h));}
.rail{background:var(--surface);border-right:1px solid var(--edge);padding:18px 16px;overflow-y:auto;}
.rail-sec{margin-bottom:22px;}
.rail label,.rail-label{display:block;font-size:11px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:var(--fg-2);margin-bottom:8px;}
.rail input,.rail select,.mode-ctl input,.mode-ctl select{width:100%;min-height:var(--control-h);background:var(--surface);border:1px solid var(--edge);border-radius:var(--radius);padding:9px 12px;font-family:var(--sans);font-size:13px;color:var(--fg);transition:border-color .16s var(--ease),box-shadow .16s var(--ease);}
.rail input::placeholder,.mode-ctl input::placeholder{color:var(--fg-3);}
.rail input:focus,.rail select:focus,.mode-ctl input:focus,.mode-ctl select:focus{outline:none;border-color:var(--fg-3);}
.rail input+input,.rail .dd,.rail button{margin-top:9px;}
#search-value:focus{border-color:var(--color-brand);box-shadow:0 0 0 3px var(--brand-ring);}
.rail .hint{font-size:11px;color:var(--fg-3);margin-top:7px;line-height:1.45;}

/* Custom dropdown — brand popover; native <select> kept hidden as state + wiring source */
.dd{position:relative;}
.dd-native{display:none;}
.dd-btn{width:100%;min-height:var(--control-h);display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--surface);border:1px solid var(--edge);border-radius:var(--radius);padding:9px 12px;font-family:var(--sans);font-size:13px;color:var(--fg);cursor:pointer;text-align:left;transition:border-color .16s var(--ease),box-shadow .16s var(--ease);}
.dd-btn:hover{border-color:var(--fg-3);}
.dd-btn:focus-visible{outline:none;border-color:var(--color-brand);box-shadow:0 0 0 3px var(--brand-ring);}
.dd-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dd-btn .chev{flex:none;color:var(--fg-2);transition:transform .16s var(--ease);}
.dd.open .dd-btn .chev{transform:rotate(180deg);}
.dd-menu{position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--surface);border:1px solid var(--edge);border-radius:var(--radius-lg);box-shadow:var(--shadow-pop);padding:5px;z-index:30;opacity:0;transform:scale(0.97);transform-origin:top center;pointer-events:none;transition:opacity .14s var(--ease),transform .14s var(--ease);max-height:288px;overflow-y:auto;}
.dd.open .dd-menu{opacity:1;transform:scale(1);pointer-events:auto;}
.dd-opt{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:var(--radius-sm);font-size:13px;color:var(--fg);cursor:pointer;}
.dd-opt:hover,.dd-opt.hl{background:var(--surface-hover);}
.dd-opt .dd-check{width:13px;flex:none;color:var(--color-brand);font-size:11px;visibility:hidden;}
.dd-opt.active{font-weight:600;}
.dd-opt.active .dd-check{visibility:visible;}

/* Activity facet chips */
#facet-group{margin-bottom:22px;}
.facet{display:inline-flex;align-items:center;font-size:11px;font-weight:600;border:1px solid var(--edge);border-radius:var(--radius-full);padding:4px 11px;margin:6px 6px 0 0;cursor:pointer;background:var(--surface);color:var(--fg-2);transition:all .12s var(--ease);}
.facet:hover{border-color:var(--fg-3);}
.facet.active{background:var(--color-brand);border-color:var(--color-brand);color:#fff;}

/* Center pane */
.center{padding:16px 20px 24px;overflow:hidden;}
.center-title{font-size:16px;font-weight:700;letter-spacing:-0.3px;margin:0 0 12px;}
.empty{padding:28px 8px;color:var(--fg-3);font-size:13px;}
#load-more{margin-top:14px;}

/* Buttons */
.btn{font-family:var(--sans);font-weight:600;border:1px solid transparent;border-radius:var(--radius);cursor:pointer;transition:background .16s var(--ease),border-color .16s var(--ease),color .16s var(--ease),transform .08s var(--ease);}
.btn:active{transform:scale(0.97);}
.btn[disabled]{opacity:.55;cursor:default;}
.btn-primary{background:var(--color-brand-strong);color:#fff;font-size:12px;padding:8px 14px;}
.btn-primary:hover{background:var(--color-brand-strong-hover);}
.btn-secondary,.btn-sm{background:var(--surface);color:var(--fg);border-color:var(--edge);font-size:11px;padding:6px 12px;}
.btn-secondary:hover,.btn-sm:hover{border-color:var(--fg-3);}
.btn-danger{background:var(--surface);color:var(--bad);border-color:var(--edge);font-size:12px;padding:8px 14px;}
.btn-danger:hover{background:var(--bad-bg);border-color:var(--bad);}
.btn-block{display:block;width:100%;}
.btn-more{width:100%;margin-top:10px;}

/* Status pills */
.pill{display:inline-flex;align-items:center;font-size:11px;font-weight:600;border-radius:var(--radius-sm);padding:2px 8px;}
.pill-ok{background:var(--ok-bg);color:var(--ok-fg);}
.pill-bad{background:var(--bad-bg);color:var(--bad-fg);}
.pill-none{background:var(--none-bg);color:var(--none-fg);}

/* Tables */
.tablewrap{overflow:auto;border:1px solid var(--edge);border-radius:var(--radius-lg);background:var(--surface);}
table{border-collapse:collapse;width:100%;table-layout:auto;}
thead th{background:var(--surface-hover);font-size:10px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:var(--fg-2);text-align:left;padding:10px 14px;white-space:nowrap;border-bottom:1px solid var(--edge);position:relative;}
thead th.num{text-align:right;}
thead th.sortable{cursor:pointer;user-select:none;}
thead th.sortable:hover{color:var(--fg);}
thead th.sorted{color:var(--fg);}
thead th .arrow{color:var(--color-brand);margin-left:5px;font-size:9px;}
thead th .rz{position:absolute;top:0;right:0;width:7px;height:100%;cursor:col-resize;user-select:none;}
tbody td{padding:11px 14px;border-bottom:1px solid var(--surface-muted);white-space:nowrap;vertical-align:middle;}
td.num{text-align:right;font-variant-numeric:tabular-nums;}
td.mono{font-family:var(--mono);font-size:11px;color:var(--fg-2);}
td.nowrap{white-space:nowrap;}
tbody tr.row-clickable{cursor:pointer;transition:background .1s var(--ease);}
tbody tr.row-clickable:hover{background:var(--surface-hover);}
tbody tr.row-clickable:hover td.mono{color:var(--fg);}

/* Usage chart — single-series magnitude over time */
.usage-head{display:flex;gap:16px;font-size:12px;color:var(--fg-2);margin-bottom:12px;}
.usage-head b{color:var(--fg);font-weight:600;}
.usage-chart{position:relative;padding-top:16px;}
.usage-ymax{position:absolute;top:0;left:0;font-size:10px;color:var(--fg-3);letter-spacing:0.3px;}
.usage-grid{position:absolute;top:15px;left:0;right:0;height:0;border-top:1px dashed var(--edge);}
.usage-bars{position:relative;display:flex;align-items:flex-end;gap:2px;height:76px;}
.usage-bars .bar{flex:1;min-width:3px;min-height:2px;background:var(--color-brand);border-radius:3px 3px 0 0;position:relative;transition:opacity .1s var(--ease);}
.usage-bars .bar:hover{opacity:.7;}
.usage-bars .bar.peak::after{content:attr(data-val);position:absolute;top:-13px;left:50%;transform:translateX(-50%);font-size:9px;font-weight:600;color:var(--color-brand-strong);white-space:nowrap;}
.usage-axis{display:flex;justify-content:space-between;margin-top:7px;font-size:10px;color:var(--fg-3);}

/* Cards */
.card{background:var(--surface);border:1px solid var(--edge);border-radius:var(--radius-lg);padding:16px 18px;margin-bottom:16px;}
.card h3{margin:0 0 12px;font-size:14px;font-weight:700;letter-spacing:-0.2px;}
.card h3.tight{margin-bottom:6px;}
.card input{width:100%;background:var(--surface);border:1px solid var(--edge);border-radius:var(--radius);padding:9px 12px;font-size:13px;color:var(--fg);margin-bottom:9px;}
.card input::placeholder{color:var(--fg-3);}
.card input:focus{outline:none;border-color:var(--fg-3);}
.card table{font-size:12px;}
.card th{text-align:left;font-weight:600;color:var(--fg-2);padding:6px 10px;white-space:nowrap;}
.balance-value{font-size:24px;font-weight:700;letter-spacing:-0.4px;}
.balance-hint{font-size:12px;color:var(--fg-2);margin-top:2px;}
.sub-line{margin-top:12px;font-size:12px;color:var(--fg-2);display:flex;align-items:center;gap:8px;}
.muted-note{font-size:12px;color:var(--fg-3);}
.detail-title{font-size:16px;font-weight:700;letter-spacing:-0.3px;margin:0 0 16px;}
.detail-title .mono{font-family:var(--mono);font-size:13px;color:var(--fg-2);}

/* Toast */
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(20px);background:var(--fg);color:var(--fg-inv);font-size:13px;font-weight:500;padding:10px 16px;border-radius:var(--radius-lg);box-shadow:var(--shadow-toast);opacity:0;pointer-events:none;transition:opacity .2s var(--ease),transform .2s var(--ease);z-index:50;}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0);}
.toast-error{background:var(--bad);}

/* Detail modal — centered dialog over a scrim */
.detail-scrim{position:fixed;inset:0;background:rgba(0,0,0,.34);z-index:40;display:flex;align-items:flex-start;justify-content:center;padding:48px 20px;overflow-y:auto;}
.detail{position:relative;width:min(720px,100%);background:var(--surface);border:1px solid var(--edge);border-radius:16px;box-shadow:var(--shadow-modal);padding:24px 26px 26px;z-index:41;animation:pop .2s var(--ease);}
@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.98);}to{opacity:1;transform:none;}}
.detail-close{position:absolute;top:16px;right:16px;}

/* Responsive */
@media (max-width:768px){
  .console-grid{grid-template-columns:1fr;}
  .rail{border-right:none;border-bottom:1px solid var(--edge);}
  .detail{width:100%;}
  .detail-scrim{padding:24px 12px;}
}
@media (pointer:coarse){
  .rail input,.rail select,.mode-ctl input,.mode-ctl select{min-height:44px;font-size:16px;}
  .btn{min-height:40px;}
}
@media (prefers-reduced-motion:reduce){
  *{transition:none !important;}
  .detail{animation:none;}
  .btn:active{transform:none;}
}
`;
