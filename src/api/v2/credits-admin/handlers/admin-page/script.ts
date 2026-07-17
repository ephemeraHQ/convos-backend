export const clientScript = (): string => `
  var TOKEN_KEY = "credits_admin_token";
  var CREDITS_PER_USD = null; // set from whoami; usdHint guards on falsy

  function el(id){ return document.getElementById(id); }
  function esc(s){ if(s==null) return ""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function fmtCredits(n){ return Number(n).toLocaleString(); }
  function fmtDate(iso){ if(!iso) return "—"; var d=new Date(iso); return d.toLocaleDateString()+" "+d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}); }
  function usdHint(c){ c=Number(c); if(!CREDITS_PER_USD||!isFinite(c)||!c) return ""; return "≈ $"+(c/CREDITS_PER_USD).toLocaleString(undefined,{maximumFractionDigits:2}); }
  function newKey(p){ return p+"_"+crypto.randomUUID(); }
  var toastTimer=null;
  function toast(msg,type){ var t=el("toast"); if(!t){ t=document.createElement("div"); t.id="toast"; document.body.appendChild(t);} t.textContent=msg; t.className="toast toast-"+(type||"success")+" show"; if(toastTimer)clearTimeout(toastTimer); toastTimer=setTimeout(function(){t.className="toast";},3200); }

  function getToken(){ return sessionStorage.getItem(TOKEN_KEY)||""; }
  function setToken(t){ sessionStorage.setItem(TOKEN_KEY,t); }
  function clearToken(){ sessionStorage.removeItem(TOKEN_KEY); }

  function apiBase(){ return window.location.origin+"/api/v2/credits-admin"; }
  function guardFetch(path,opts){
    opts=opts||{};
    return fetch(apiBase()+path, Object.assign({},opts,{
      headers: Object.assign({"Content-Type":"application/json","Authorization":"Bearer "+getToken()}, opts.headers||{})
    })).then(function(r){ if(r.status===401){ clearToken(); showLogin("Session expired — re-enter token"); throw new Error("reauth"); } return r; });
  }

  function showLogin(msg){ el("console").classList.add("hidden"); el("login").classList.remove("hidden"); el("login-error").textContent=msg||""; }
  function showConsole(){ el("login").classList.add("hidden"); el("console").classList.remove("hidden"); }

  function applyWhoami(j){ CREDITS_PER_USD=Number(j.creditsPerUsd)||0; el("identity").textContent=j.actorEmail||""; }

  var loginGen=0;
  function attemptLogin(token){
    var gen=++loginGen;
    setToken(token);
    return fetch(apiBase()+"/whoami",{headers:{"Authorization":"Bearer "+token}})
      .then(function(r){ if(r.status!==200){ throw new Error(r.status===401?"Invalid token":"Auth unavailable ("+r.status+")"); } return r.json(); })
      .then(function(j){ if(gen!==loginGen) return; applyWhoami(j); showConsole(); loadActivity(true); })
      .catch(function(err){ if(gen!==loginGen) return; clearToken(); showLogin(err.message||"Login failed"); });
  }

  function lock(){ loginGen++; clearToken(); showLogin("Locked"); }

  // --- wiring ---
  el("unlock").addEventListener("click", function(){ var t=el("token-input").value.trim(); if(!t){ el("login-error").textContent="Enter a token"; return; } el("login-error").textContent=""; attemptLogin(t); });
  el("token-input").addEventListener("keydown", function(e){ if(e.key==="Enter") el("unlock").click(); });
  el("lock").addEventListener("click", lock);
  el("brand").addEventListener("click", function(){ closeDetail(); });
  el("detail-close").addEventListener("click", closeDetail);
  el("detail-scrim").addEventListener("click", function(e){ if(e.target===el("detail-scrim")) closeDetail(); });
  document.addEventListener("keydown", function(e){ if(e.key==="Escape" && el("detail-scrim") && !el("detail-scrim").classList.contains("hidden")) closeDetail(); });

  // --- stubs completed in later tasks ---
  var activityAction="all";
  var activityCursor=null;
  var activityGen=0;
  function renderActivityRows(rows, append){
    var tb=document.querySelector("#activity-table tbody");
    var html=rows.map(function(r){
      return '<tr class="row-clickable" data-account="'+esc(r.accountId)+'">'
        +'<td class="nowrap">'+fmtDate(r.createdAt)+"</td><td>"+esc(r.actorEmail)+'</td><td class="mono">'+esc(r.accountId)
        +"</td><td>"+esc(r.action)+'</td><td class="num">'+esc(r.deltaCredits)+"</td><td>"+esc(r.reason)+"</td></tr>";
    }).join("");
    if(append){ tb.insertAdjacentHTML("beforeend", html); } else { tb.innerHTML=html; }
    Array.prototype.forEach.call(document.querySelectorAll("#activity-table tbody tr.row-clickable"), function(tr){
      tr.onclick=function(){ openDetail(tr.getAttribute("data-account")); };
    });
  }
  function loadActivity(reset){
    if(reset){ activityCursor=null; }
    var gen=++activityGen;
    var qs="?action="+encodeURIComponent(activityAction)+(activityCursor?("&cursor="+encodeURIComponent(activityCursor)):"");
    guardFetch("/audit/recent"+qs).then(function(r){ if(!r.ok){ throw new Error("load_failed"); } return r.json(); }).then(function(j){
      if(gen!==activityGen) return;
      if(currentView!=="activity") return;
      renderActivityRows(j.rows||[], !reset);
      activityCursor=j.nextCursor;
      el("load-more").classList.toggle("hidden", !j.nextCursor);
      var empty = reset && (!j.rows || j.rows.length===0);
      el("activity-empty").textContent = "No matching activity.";
      el("activity-empty").classList.toggle("hidden", !empty);
    }).catch(function(e){ if(e.message!=="reauth") toast("Failed to load activity","error"); });
  }
  el("load-more").addEventListener("click", function(){ if(currentView==="activity"){ loadActivity(false); } else { loadAccounts(false); } });
  Array.prototype.forEach.call(document.querySelectorAll(".facet"), function(f){
    f.addEventListener("click", function(){
      Array.prototype.forEach.call(document.querySelectorAll(".facet"), function(x){ x.classList.remove("active"); });
      f.classList.add("active");
      activityAction=f.getAttribute("data-action");
      loadActivity(true);
    });
  });
  function doSearch(){
    var value=el("search-value").value.trim();
    if(!value) return;
    guardFetch("/search?value="+encodeURIComponent(value))
      .then(function(r){ return r.json(); })
      .then(function(j){ if(!j.accountId){ toast("No account found","error"); return; } openDetail(j.accountId); })
      .catch(function(e){ if(e.message!=="reauth") toast("Search failed","error"); });
  }
  el("search-btn").addEventListener("click", doSearch);
  el("search-value").addEventListener("keydown", function(e){ if(e.key==="Enter") doSearch(); });
  var currentView="activity";
  var accountsGen=0;
  var accountsMode={balance:"balance",broken:"broken",grantKind:"grantKind",active:"activity",dormant:"activity"};
  function accountsPage(){ return el("accounts-wrap"); }
  function showModeControls(view){
    Array.prototype.forEach.call(document.querySelectorAll(".mode-ctl"), function(c){ c.classList.add("hidden"); });
    el("facet-group").classList.toggle("hidden", view!=="activity");
    if(view==="balance") el("ctl-balance").classList.remove("hidden");
    else if(view==="broken") el("ctl-broken").classList.remove("hidden");
    else if(view==="grantKind") el("ctl-grantKind").classList.remove("hidden");
    else if(view==="active"||view==="dormant") el("ctl-activity").classList.remove("hidden");
  }
  function accountsQuery(view, pageNo){
    var qs="?mode="+encodeURIComponent(accountsMode[view])+"&page="+pageNo;
    var st=accountsSort[view];
    if(st){ qs+="&sortBy="+encodeURIComponent(st.by)+"&sortDir="+encodeURIComponent(st.dir); }
    if(view==="balance"){ var mn=el("bal-min").value, mx=el("bal-max").value;
      if(mn!=="") qs+="&min="+encodeURIComponent(mn); if(mx!=="") qs+="&max="+encodeURIComponent(mx); }
    else if(view==="broken"){ qs+="&maxBalance="+encodeURIComponent(el("broken-max").value||"0"); }
    else if(view==="grantKind"){ qs+="&kind="+encodeURIComponent(el("gk-kind").value); }
    else if(view==="active"||view==="dormant"){ qs+="&state="+(view==="active"?"active":"dormant")+"&days="+encodeURIComponent(el("act-days").value||"30"); }
    return qs;
  }
  var accountsPageNo=0;
  var accountsSort={ balance:{by:"balance",dir:"desc"}, broken:{by:"balance",dir:"asc"}, grantKind:{by:"latestGrantAt",dir:"desc"}, active:{by:"lastConsumeAt",dir:"desc"}, dormant:{by:"lastConsumeAt",dir:"desc"} };
  var colAccount=["Account",function(r){return r.accountId;},"mono"];
  var colBalance=["Balance",function(r){return fmtCredits(r.balanceCredits);},"num","balance"];
  var colWallet=["Wallet",function(r){return r.wallet||"—";},"mono"];
  var colLastActivity=["Last activity",function(r){return fmtDate(r.lastConsumeAt);},"nowrap"];
  var userListCols=[colAccount,colBalance,["Last consume",function(r){return fmtDate(r.lastConsumeAt);},"nowrap","lastConsumeAt"]];
  var accountCols={
    balance:[colAccount,colWallet,colLastActivity,colBalance],
    broken:[colAccount,colBalance,["Tier",function(r){return r.tier||"—";},null,"tier"],["Status",function(r){return r.effectiveStatus||"—";}],["Period end",function(r){return fmtDate(r.currentPeriodEnd);},"nowrap","currentPeriodEnd"]],
    grantKind:[colAccount,colBalance,["Latest grant",function(r){return fmtDate(r.latestGrantAt);},"nowrap","latestGrantAt"]],
    active:userListCols,
    dormant:userListCols
  };
  var viewTitles={
    activity:"Recent admin activity",
    balance:"Accounts by balance",
    broken:"Broken subscribers",
    grantKind:"Accounts by grant kind",
    active:"Active users",
    dormant:"Dormant users"
  };
  function renderAccountRows(rows, view, append){
    var cols=accountCols[view];
    var st=accountsSort[view]||{};
    function colCls(c){ return c[2]?' class="'+c[2]+'"':""; }
    if(!append){
      el("accounts-head").innerHTML=cols.map(function(c){
        var key=c[3];
        var sortable = !!key;
        var isSorted = sortable && st.by===key;
        var arrow = isSorted ? '<span class="arrow">'+(st.dir==="asc"?"▲":"▼")+"</span>" : "";
        var cls = (c[2]?c[2]+" ":"") + (sortable?"sortable ":"") + (isSorted?"sorted":"");
        cls = cls.trim();
        return "<th"+(cls?' class="'+cls+'"':"")+(sortable?' data-sort="'+esc(key)+'"':"")+">"+esc(c[0])+arrow+'<span class="rz" data-rz="1"></span></th>';
      }).join("");
      wireHeaderSort(view);
      wireColumnResize();
    }
    var tb=document.querySelector("#accounts-table tbody");
    var html=(rows||[]).map(function(r){
      return '<tr class="row-clickable" data-account="'+esc(r.accountId)+'">'
        +cols.map(function(c){ return "<td"+colCls(c)+">"+esc(c[1](r))+"</td>"; }).join("")+"</tr>";
    }).join("");
    if(append){ tb.insertAdjacentHTML("beforeend", html); } else { tb.innerHTML=html; }
    Array.prototype.forEach.call(document.querySelectorAll("#accounts-table tbody tr.row-clickable"), function(tr){
      tr.onclick=function(){ openDetail(tr.getAttribute("data-account")); };
    });
  }
  function wireHeaderSort(view){
    Array.prototype.forEach.call(document.querySelectorAll("#accounts-head th.sortable"), function(th){
      th.addEventListener("click", function(e){
        if(e.target && e.target.getAttribute && e.target.getAttribute("data-rz")) return;
        var key=th.getAttribute("data-sort"), st=accountsSort[view];
        if(st.by===key){ st.dir = st.dir==="asc"?"desc":"asc"; } else { st.by=key; st.dir="desc"; }
        loadAccounts(true);
      });
    });
  }
  function wireColumnResize(){
    Array.prototype.forEach.call(document.querySelectorAll("#accounts-head .rz"), function(h){
      h.addEventListener("mousedown", function(e){
        e.preventDefault(); e.stopPropagation();
        var th=h.parentNode, startX=e.pageX, startW=th.offsetWidth;
        function move(ev){ var w=Math.max(48,startW+(ev.pageX-startX)); th.style.width=w+"px"; th.style.minWidth=w+"px"; }
        function up(){ document.removeEventListener("mousemove",move); document.removeEventListener("mouseup",up); }
        document.addEventListener("mousemove",move); document.addEventListener("mouseup",up);
      });
    });
  }
  function loadAccounts(reset){
    if(reset){ accountsPageNo=0; }
    var view=currentView, gen=++accountsGen, pageNo=reset?0:accountsPageNo+1;
    guardFetch("/accounts"+accountsQuery(view, pageNo)).then(function(r){ if(!r.ok){ throw new Error("load_failed"); } return r.json(); }).then(function(j){
      if(gen!==accountsGen) return;
      if(view!==currentView) return;
      accountsPageNo=pageNo;
      renderAccountRows(j.rows||[], view, !reset);
      el("load-more").classList.toggle("hidden", !j.hasMore);
      var empty = reset && (!j.rows || j.rows.length===0);
      el("activity-empty").textContent = "No matching accounts.";
      el("activity-empty").classList.toggle("hidden", !empty);
    }).catch(function(e){ if(e.message!=="reauth") toast("Failed to load accounts","error"); });
  }
  function setView(view){
    currentView=view;
    showModeControls(view);
    el("center-title").textContent=viewTitles[view];
    var isActivity = view==="activity";
    el("activity-wrap").classList.toggle("hidden", !isActivity);
    accountsPage().classList.toggle("hidden", isActivity);
    el("activity-empty").classList.add("hidden");
    el("load-more").classList.add("hidden");
    if(isActivity){ loadActivity(true); } else { loadAccounts(true); }
  }
  el("view-mode").addEventListener("change", function(){ setView(el("view-mode").value); });
  Array.prototype.forEach.call(document.querySelectorAll(".mode-ctl input, .mode-ctl select"), function(c){
    c.addEventListener("change", function(){ if(currentView!=="activity") loadAccounts(true); });
  });
  var currentAccountId=null;
  var ledgerCursor=null, auditCursor=null;
  var ledgerFilter={kind:"",reason:"",from:"",to:""};
  var ledgerGen=0;
  var detailGen=0;
  function subChip(j){
    var state=j.subscription?j.subscription.effectiveStatus:"none";
    var cls=!j.subscription?"pill-none":(j.isEntitled?"pill-ok":"pill-bad");
    return '<span class="pill '+cls+'">'+esc(state)+"</span>";
  }
  function renderUsage(usage){
    if(!usage||!usage.length) return '<span class="muted-note">No usage in the last 30 days.</span>';
    var max=usage.reduce(function(m,u){ var c=Number(u.consumed); return c>m?c:m; },0);
    var total=usage.reduce(function(s,u){ return s+Number(u.consumed); },0);
    var bars=usage.map(function(u){ var c=Number(u.consumed); var h=max>0?Math.max(2,Math.round(c/max*100)):2;
      return '<div class="bar'+(max>0&&c===max?" peak":"")+'" style="height:'+h+'%" data-val="'+esc(fmtCredits(c))+'" title="'+esc(u.bucketStart+" · "+fmtCredits(c)+" credits")+'"></div>'; }).join("");
    var firstDate=fmtDate(usage[0].bucketStart).split(" ")[0];
    var lastDate=fmtDate(usage[usage.length-1].bucketStart).split(" ")[0];
    return '<div class="usage-head"><span>Peak <b>'+esc(fmtCredits(max))+'</b>/day</span><span>Total <b>'+esc(fmtCredits(total))+'</b> · 30d</span></div>'
      +'<div class="usage-chart"><div class="usage-ymax">'+esc(fmtCredits(max))+'</div><div class="usage-grid"></div><div class="usage-bars">'+bars+'</div></div>'
      +'<div class="usage-axis"><span>'+esc(firstDate)+'</span><span>'+esc(lastDate)+'</span></div>';
  }
  function rowsHtml(rows, cols){
    return (rows||[]).map(function(r){ return "<tr>"+cols.map(function(c){
      var fn = typeof c==="function" ? c : c[0], cls = typeof c==="function" ? "" : c[1];
      return "<td"+(cls?' class="'+cls+'"':"")+">"+fn(r)+"</td>";
    }).join("")+"</tr>"; }).join("");
  }
  function currentFilterFromControls(){
    return {
      kind: el("d-lf-kind").value,
      reason: el("d-lf-reason").value,
      from: el("d-lf-from").value,
      to: el("d-lf-to").value
    };
  }
  function buildLedgerQuery(filter, cursor){
    var p=[];
    if(filter.kind) p.push("kind="+encodeURIComponent(filter.kind));
    if(filter.reason) p.push("reason="+encodeURIComponent(filter.reason));
    if(filter.from) p.push("from="+encodeURIComponent(filter.from));
    if(filter.to) p.push("to="+encodeURIComponent(filter.to));
    if(cursor) p.push("cursor="+encodeURIComponent(cursor));
    return p.length?("?"+p.join("&")):"";
  }
  function applyLedgerFilter(){
    if(!currentAccountId) return;
    var f=currentFilterFromControls();
    var acct=currentAccountId, gen=detailGen, myGen=++ledgerGen;
    el("d-ledger-foot").innerHTML="";
    guardFetch("/accounts/"+encodeURIComponent(acct)+"/ledger"+buildLedgerQuery(f,null))
      .then(function(r){ if(!r.ok) throw new Error("filter_failed"); return r.json(); })
      .then(function(j){ if(acct!==currentAccountId||gen!==detailGen||myGen!==ledgerGen) return;
        ledgerFilter=f;
        var rows=j.rows||[];
        ledgerCursor=j.nextCursor||null;
        if(rows.length===0){
          el("d-ledger").innerHTML='<tr><td class="muted-note">No movements match this filter.</td></tr>';
          el("d-ledger-foot").innerHTML="";
          return;
        }
        el("d-ledger").innerHTML=rowsHtml(rows, ledgerCols);
        paintFoot("d-ledger-foot", true, ledgerCursor, function(){ loadLedgerMore(); });
      })
      .catch(function(e){ if(acct!==currentAccountId||gen!==detailGen||myGen!==ledgerGen) return; paintFoot("d-ledger-foot", true, ledgerCursor, function(){ loadLedgerMore(); }); if(e.message!=="reauth") toast("Failed to filter ledger","error"); });
  }
  var ledgerCols=[[function(r){return fmtDate(r.createdAt);},"nowrap"],[function(r){return esc(r.delta);},"num"],function(r){return esc(r.reason);},[function(r){return esc(r.grantKindId||"—");},"mono"],function(r){return esc(r.note||"");}];
  function paintFoot(footId, hasRows, nextCursor, moreFn){
    var foot=el(footId); if(!foot) return;
    if(!hasRows){ foot.innerHTML='<div class="muted-note">Nothing here yet.</div>'; return; }
    if(nextCursor){ foot.innerHTML='<button class="btn btn-secondary btn-more">Load more</button>'; foot.querySelector("button").onclick=moreFn; }
    else { foot.innerHTML=""; }
  }
  function renderLedgerFirst(j){
    ledgerCursor=j.ledgerNextCursor||null;
    el("d-ledger").innerHTML = rowsHtml(j.ledger, ledgerCols);
    paintFoot("d-ledger-foot", (j.ledger&&j.ledger.length>0), ledgerCursor, function(){ loadLedgerMore(); });
  }
  function loadLedgerMore(){
    if(!ledgerCursor||!currentAccountId) return;
    var btn=el("d-ledger-foot")&&el("d-ledger-foot").querySelector("button"); if(btn&&btn.disabled) return; if(btn) btn.disabled=true;
    var acct=currentAccountId, gen=detailGen, myGen=ledgerGen;
    guardFetch("/accounts/"+encodeURIComponent(acct)+"/ledger"+buildLedgerQuery(ledgerFilter,ledgerCursor))
      .then(function(r){ if(!r.ok) throw new Error("more_failed"); return r.json(); })
      .then(function(j){ if(acct!==currentAccountId||gen!==detailGen||myGen!==ledgerGen) return;
        el("d-ledger").insertAdjacentHTML("beforeend", rowsHtml(j.rows, ledgerCols));
        ledgerCursor=j.nextCursor||null;
        paintFoot("d-ledger-foot", true, ledgerCursor, function(){ loadLedgerMore(); });
      })
      .catch(function(e){ if(acct!==currentAccountId||gen!==detailGen||myGen!==ledgerGen) return; paintFoot("d-ledger-foot", true, ledgerCursor, function(){ loadLedgerMore(); }); if(e.message!=="reauth") toast("Failed to load more","error"); });
  }
  function renderDetail(j){
    var sub=j.subscription;
    var subBlock = sub
      ? '<table><tbody>'
        +"<tr><th>Tier</th><td>"+esc(sub.tier)+"</td></tr>"
        +"<tr><th>Stored status</th><td>"+esc(sub.storedStatus)+"</td></tr>"
        +"<tr><th>Effective status</th><td>"+esc(sub.effectiveStatus)+"</td></tr>"
        +"<tr><th>Period</th><td>"+fmtDate(sub.currentPeriodStart)+" → "+fmtDate(sub.currentPeriodEnd)+"</td></tr>"
        +"<tr><th>Environment</th><td>"+esc(sub.environment)+"</td></tr>"
        +"<tr><th>Allotment (per period)</th><td>"+fmtCredits(sub.perPeriodCredits)+" credits</td></tr>"
        +"<tr><th>Period consumes</th><td>"+fmtCredits(j.periodConsumesCredits)+" credits</td></tr>"
        +"</tbody></table>"
      : '<div class="muted-note">No subscription on record.</div>';
    el("detail-body").innerHTML =
      '<h2 class="detail-title">Account <span class="mono">'+esc(j.accountId)+'</span></h2>'
      +'<div class="card"><h3 class="tight">Balance</h3><div class="balance-value">'+fmtCredits(j.balanceCredits)+'</div>'
      +'<div class="balance-hint">'+usdHint(j.balanceCredits)+'</div>'
      +'<div class="sub-line">Subscription: '+subChip(j)+'</div></div>'
      +'<div class="card"><h3>Subscription</h3>'+subBlock+'</div>'
      +'<div class="card"><h3>Grant</h3><input id="d-grant-credits" type="number" min="1" placeholder="Credits"><input id="d-grant-reason" placeholder="Reason"><button id="d-grant-btn" class="btn btn-primary">Grant</button></div>'
      +'<div class="card"><h3>Adjust</h3><input id="d-adjust-delta" type="number" placeholder="±credits"><input id="d-adjust-reason" placeholder="Reason"><button id="d-adjust-btn" class="btn btn-danger">Adjust</button></div>'
      +'<div class="card"><h3>Usage (30d)</h3><div id="usage-spark"></div></div>'
      +'<div class="card"><h3>Daily refills</h3><div class="tablewrap"><table><tbody id="d-refills"></tbody></table></div></div>'
      +'<div class="card"><h3>Ledger movements</h3>'
      +'<div class="ledger-filter">'
      +'<select id="d-lf-kind">'
      +'<option value="">Kind: all</option>'
      +'<option value="subscription">Subscription (grants + forfeits)</option>'
      +'<option value="sub_grant">Sub grant</option>'
      +'<option value="sub_forfeit">Sub forfeit</option>'
      +'<option value="signup_bonus">Signup bonus</option>'
      +'<option value="daily_refill">Daily refill</option>'
      +'<option value="manual">Manual</option>'
      +'</select>'
      +'<select id="d-lf-reason">'
      +'<option value="">Reason: all</option>'
      +'<option value="consume">consume</option>'
      +'<option value="grant">grant</option>'
      +'<option value="adjust">adjust</option>'
      +'</select>'
      +'<input id="d-lf-from" type="date" aria-label="From date">'
      +'<input id="d-lf-to" type="date" aria-label="To date">'
      +'<button id="d-lf-clear" class="btn btn-secondary">Clear</button>'
      +'</div>'
      +'<div class="tablewrap"><table><tbody id="d-ledger"></tbody></table></div><div id="d-ledger-foot"></div></div>'
      +'<div class="card"><h3>Admin audit</h3><div class="tablewrap"><table><tbody id="d-audit"></tbody></table></div><div id="d-audit-foot"></div></div>';
    el("usage-spark").innerHTML = renderUsage(j.usageDaily);
    el("d-refills").innerHTML = (j.dailyRefills&&j.dailyRefills.length)
      ? rowsHtml(j.dailyRefills,[[function(r){return fmtDate(r.createdAt);},"nowrap"],[function(r){return esc(r.delta);},"num"],function(r){return esc(r.note||"");}])
      : '<tr><td class="muted-note">No daily refills.</td></tr>';
    renderLedgerFirst(j);
    el("d-grant-btn").addEventListener("click", function(){ mutate("grant"); });
    el("d-adjust-btn").addEventListener("click", function(){ mutate("adjust"); });
    ["d-lf-kind","d-lf-reason","d-lf-from","d-lf-to"].forEach(function(id){
      el(id).addEventListener("change", applyLedgerFilter);
    });
    el("d-lf-clear").addEventListener("click", function(){
      el("d-lf-kind").value=""; el("d-lf-reason").value="";
      el("d-lf-from").value=""; el("d-lf-to").value="";
      applyLedgerFilter();
    });
  }
  var auditCols=[[function(r){return fmtDate(r.createdAt);},"nowrap"],function(r){return esc(r.actorEmail);},function(r){return esc(r.action);},[function(r){return esc(r.deltaCredits);},"num"],function(r){return esc(r.reason);}];
  function loadAudit(accountId){
    guardFetch("/audit?accountId="+encodeURIComponent(accountId)).then(function(r){ return r.json(); }).then(function(j){
      if(accountId!==currentAccountId) return;
      auditCursor=j.nextCursor||null;
      el("d-audit").innerHTML = rowsHtml(j.audit, auditCols);
      paintFoot("d-audit-foot", (j.audit&&j.audit.length>0), auditCursor, function(){ loadAuditMore(); });
    }).catch(function(){});
  }
  function loadAuditMore(){
    if(!auditCursor||!currentAccountId) return;
    var btn=el("d-audit-foot")&&el("d-audit-foot").querySelector("button"); if(btn&&btn.disabled) return; if(btn) btn.disabled=true;
    var acct=currentAccountId, gen=detailGen;
    guardFetch("/audit?accountId="+encodeURIComponent(acct)+"&cursor="+encodeURIComponent(auditCursor))
      .then(function(r){ if(!r.ok) throw new Error("more_failed"); return r.json(); })
      .then(function(j){ if(acct!==currentAccountId||gen!==detailGen) return;
        el("d-audit").insertAdjacentHTML("beforeend", rowsHtml(j.audit, auditCols));
        auditCursor=j.nextCursor||null;
        paintFoot("d-audit-foot", true, auditCursor, function(){ loadAuditMore(); });
      })
      .catch(function(e){ paintFoot("d-audit-foot", true, auditCursor, function(){ loadAuditMore(); }); if(e.message!=="reauth") toast("Failed to load more","error"); });
  }
  function openDetail(accountId){
    currentAccountId=accountId;
    ledgerFilter={kind:"",reason:"",from:"",to:""};
    detailGen++;
    el("detail-body").innerHTML='<div class="muted-note">Loading…</div>';
    el("detail").setAttribute("aria-hidden","false"); el("detail-scrim").classList.remove("hidden");
    guardFetch("/accounts/"+encodeURIComponent(accountId)).then(function(r){ if(r.status===404){ throw new Error("not_found"); } return r.json(); })
      .then(function(j){ if(accountId!==currentAccountId) return; renderDetail(j); loadAudit(accountId); })
      .catch(function(e){ if(accountId!==currentAccountId) return; if(e.message==="not_found"){ el("detail-body").innerHTML='<div class="pill pill-bad">Account not found</div>'; } else if(e.message!=="reauth"){ toast("Failed to load account","error"); } });
  }
  function mutate(kind){
    if(!currentAccountId) return;
    var body, path, btn;
    if(kind==="grant"){ var c=Number(el("d-grant-credits").value); var gr=el("d-grant-reason").value.trim();
      if(!isFinite(c)||c<=0||Math.floor(c)!==c){ toast("Positive integer credits required","error"); return; } if(!gr){ toast("Reason required","error"); return; }
      body={credits:c,reason:gr,idempotencyKey:newKey("admin_grant")}; path="/grant"; btn=el("d-grant-btn"); }
    else { var d=Number(el("d-adjust-delta").value); var ar=el("d-adjust-reason").value.trim();
      if(!isFinite(d)||d===0||Math.floor(d)!==d){ toast("Non-zero integer delta required","error"); return; } if(!ar){ toast("Reason required","error"); return; }
      body={delta:d,reason:ar,idempotencyKey:newKey("admin_adjust")}; path="/adjust"; btn=el("d-adjust-btn"); }
    if(btn) btn.disabled=true;
    guardFetch("/accounts/"+encodeURIComponent(currentAccountId)+path,{method:"POST",body:JSON.stringify(body)})
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
      .then(function(res){ if(!res.ok){ if(btn) btn.disabled=false; toast(res.j.code==="insufficient_balance"?"Below floor":(res.j.code==="idempotency_mismatch"?"Idempotency mismatch":"Failed"),"error"); return; }
        toast(res.j.replayed?"Already applied":(kind==="grant"?"Granted":"Adjusted"),"success"); openDetail(currentAccountId); loadActivity(true); })
      .catch(function(e){ if(btn) btn.disabled=false; if(e.message!=="reauth") toast("Failed","error"); });
  }
  function closeDetail(){ var d=el("detail"); if(d){ d.setAttribute("aria-hidden","true"); } var s=el("detail-scrim"); if(s) s.classList.add("hidden"); }

  // Custom dropdown: brand popover over a hidden native <select> that stays the
  // value source, so existing change-listeners keep working via dispatchEvent.
  function initDropdown(dd){
    var sel=dd.querySelector(".dd-native"), btn=dd.querySelector(".dd-btn"), menu=dd.querySelector(".dd-menu"), label=dd.querySelector(".dd-label"), hl=-1;
    function syncLabel(){ label.textContent=sel.options[sel.selectedIndex].text; }
    function buildMenu(){ menu.innerHTML=Array.prototype.map.call(sel.options,function(o,i){
      return '<div class="dd-opt'+(i===sel.selectedIndex?" active":"")+'" role="option" data-i="'+i+'"><span class="dd-check">✓</span>'+esc(o.text)+"</div>"; }).join(""); }
    function opts(){ return menu.querySelectorAll(".dd-opt"); }
    function highlight(i){ var os=opts(); if(!os.length) return; hl=(i+os.length)%os.length; Array.prototype.forEach.call(os,function(x,j){ x.classList.toggle("hl", j===hl); }); os[hl].scrollIntoView({block:"nearest"}); }
    function open(){ buildMenu(); dd.classList.add("open"); btn.setAttribute("aria-expanded","true"); highlight(sel.selectedIndex); }
    function close(){ dd.classList.remove("open"); btn.setAttribute("aria-expanded","false"); }
    function choose(i){ if(sel.selectedIndex!==i){ sel.selectedIndex=i; sel.dispatchEvent(new Event("change")); } syncLabel(); close(); btn.focus(); }
    btn.addEventListener("click", function(){ dd.classList.contains("open")?close():open(); });
    menu.addEventListener("click", function(e){ var o=e.target.closest?e.target.closest(".dd-opt"):null; if(o) choose(Number(o.getAttribute("data-i"))); });
    dd.addEventListener("keydown", function(e){
      var isOpen=dd.classList.contains("open");
      if(e.key==="Escape"){ if(isOpen){ e.preventDefault(); close(); btn.focus(); } return; }
      if(!isOpen){ if(e.key==="ArrowDown"||e.key==="Enter"||e.key===" "){ e.preventDefault(); open(); } return; }
      if(e.key==="ArrowDown"){ e.preventDefault(); highlight(hl+1); }
      else if(e.key==="ArrowUp"){ e.preventDefault(); highlight(hl-1); }
      else if(e.key==="Enter"||e.key===" "){ e.preventDefault(); if(hl>=0) choose(hl); }
    });
    document.addEventListener("click", function(e){ if(!dd.contains(e.target)) close(); });
    syncLabel();
  }
  Array.prototype.forEach.call(document.querySelectorAll(".dd"), initDropdown);

  // --- boot: silent re-auth if a token is already stored ---
  (function boot(){ var t=getToken(); if(t){ attemptLogin(t); } else { showLogin(); } })();
`;
