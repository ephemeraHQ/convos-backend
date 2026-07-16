export const clientScript = (): string => `
  var TOKEN_KEY = "credits_admin_token";
  var CREDITS_PER_USD = null; // set from whoami; usdHint guards on falsy

  function el(id){ return document.getElementById(id); }
  function esc(s){ if(s==null) return ""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function fmtCredits(n){ return Number(n).toLocaleString(); }
  function fmtDate(iso){ if(!iso) return "—"; var d=new Date(iso); return d.toLocaleDateString()+" "+d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}); }
  function usdHint(c){ c=Number(c); if(!CREDITS_PER_USD||!isFinite(c)||!c) return ""; return "≈ $"+(c/CREDITS_PER_USD).toLocaleString(undefined,{maximumFractionDigits:2}); }
  function newKey(p){ return p+"_"+crypto.randomUUID(); }
  function shortId(id){ return id ? String(id).slice(0,8)+"…" : "—"; }
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
  el("detail-scrim").addEventListener("click", closeDetail);

  // --- stubs completed in later tasks ---
  var activityAction="all";
  var activityCursor=null;
  var activityGen=0;
  function renderActivityRows(rows, append){
    var tb=document.querySelector("#activity-table tbody");
    var html=rows.map(function(r){
      return '<tr class="row-clickable" data-account="'+esc(r.accountId)+'">'
        +'<td class="nowrap">'+fmtDate(r.createdAt)+"</td><td>"+esc(r.actorEmail)+'</td><td class="mono">'+esc(shortId(r.accountId))
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
    if(view==="balance"){ var mn=el("bal-min").value, mx=el("bal-max").value;
      if(mn!=="") qs+="&min="+encodeURIComponent(mn); if(mx!=="") qs+="&max="+encodeURIComponent(mx);
      qs+="&sort="+encodeURIComponent(el("bal-sort").value); }
    else if(view==="broken"){ qs+="&maxBalance="+encodeURIComponent(el("broken-max").value||"0"); }
    else if(view==="grantKind"){ qs+="&kind="+encodeURIComponent(el("gk-kind").value); }
    else if(view==="active"||view==="dormant"){ qs+="&state="+(view==="active"?"active":"dormant")+"&days="+encodeURIComponent(el("act-days").value||"30"); }
    return qs;
  }
  var accountsPageNo=0;
  var colAccount=["Account",function(r){return shortId(r.accountId);},"mono"];
  var colBalance=["Balance",function(r){return fmtCredits(r.balanceCredits);},"num"];
  var userListCols=[colAccount,colBalance,["Last consume",function(r){return fmtDate(r.lastConsumeAt);},"nowrap"]];
  var accountCols={
    balance:[colAccount,colBalance],
    broken:[colAccount,colBalance,["Tier",function(r){return r.tier||"—";}],["Status",function(r){return r.effectiveStatus||"—";}]],
    grantKind:[colAccount,colBalance,["Latest grant",function(r){return fmtDate(r.latestGrantAt);},"nowrap"]],
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
    function colCls(c){ return c[2]?' class="'+c[2]+'"':""; }
    el("accounts-head").innerHTML=cols.map(function(c){ return "<th"+colCls(c)+">"+esc(c[0])+"</th>"; }).join("");
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
  function subChip(j){
    var state=j.subscription?j.subscription.effectiveStatus:"none";
    var cls=!j.subscription?"pill-none":(j.isEntitled?"pill-ok":"pill-bad");
    return '<span class="pill '+cls+'">'+esc(state)+"</span>";
  }
  function renderSpark(usage){
    if(!usage||!usage.length) return '<span class="muted-note">No usage in the last 30 days.</span>';
    var max=usage.reduce(function(m,u){ var c=Number(u.consumed); return c>m?c:m; },0);
    return usage.map(function(u){ var c=Number(u.consumed); var h=max>0?Math.max(2,Math.round(c/max*100)):2;
      return '<div class="bar" style="height:'+h+'%" title="'+esc(u.bucketStart+" · "+fmtCredits(u.consumed)+" credits")+'"></div>'; }).join("");
  }
  function rowsHtml(rows, cols){
    return (rows||[]).map(function(r){ return "<tr>"+cols.map(function(c){
      var fn = typeof c==="function" ? c : c[0], cls = typeof c==="function" ? "" : c[1];
      return "<td"+(cls?' class="'+cls+'"':"")+">"+fn(r)+"</td>";
    }).join("")+"</tr>"; }).join("");
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
      '<h2 class="detail-title">Account <span class="mono">'+esc(shortId(j.accountId))+'</span></h2>'
      +'<div class="card"><h3 class="tight">Balance</h3><div class="balance-value">'+fmtCredits(j.balanceCredits)+'</div>'
      +'<div class="balance-hint">'+usdHint(j.balanceCredits)+'</div>'
      +'<div class="sub-line">Subscription: '+subChip(j)+'</div></div>'
      +'<div class="card"><h3>Subscription</h3>'+subBlock+'</div>'
      +'<div class="card"><h3>Grant</h3><input id="d-grant-credits" type="number" min="1" placeholder="credits"><input id="d-grant-reason" placeholder="reason"><button id="d-grant-btn" class="btn btn-primary">Grant</button></div>'
      +'<div class="card"><h3>Adjust</h3><input id="d-adjust-delta" type="number" placeholder="±credits"><input id="d-adjust-reason" placeholder="reason"><button id="d-adjust-btn" class="btn btn-danger">Adjust</button></div>'
      +'<div class="card"><h3>Usage (30d)</h3><div id="usage-spark" class="spark"></div></div>'
      +'<div class="card"><h3>Daily refills</h3><div class="tablewrap"><table><tbody id="d-refills"></tbody></table></div></div>'
      +'<div class="card"><h3>Recent ledger</h3><div class="tablewrap"><table><tbody id="d-ledger"></tbody></table></div></div>'
      +'<div class="card"><h3>Admin audit</h3><div class="tablewrap"><table><tbody id="d-audit"></tbody></table></div></div>';
    el("usage-spark").innerHTML = renderSpark(j.usageDaily);
    el("d-refills").innerHTML = (j.dailyRefills&&j.dailyRefills.length)
      ? rowsHtml(j.dailyRefills,[[function(r){return fmtDate(r.createdAt);},"nowrap"],[function(r){return esc(r.delta);},"num"],function(r){return esc(r.note||"");}])
      : '<tr><td class="muted-note">No daily refills.</td></tr>';
    el("d-ledger").innerHTML = rowsHtml(j.ledger,[[function(r){return fmtDate(r.createdAt);},"nowrap"],[function(r){return esc(r.delta);},"num"],function(r){return esc(r.reason);},[function(r){return esc(r.grantKindId||"—");},"mono"],function(r){return esc(r.note||"");}]);
    el("d-grant-btn").addEventListener("click", function(){ mutate("grant"); });
    el("d-adjust-btn").addEventListener("click", function(){ mutate("adjust"); });
  }
  function loadAudit(accountId){
    guardFetch("/audit?accountId="+encodeURIComponent(accountId)).then(function(r){ return r.json(); }).then(function(j){
      el("d-audit").innerHTML = rowsHtml(j.audit,[[function(r){return fmtDate(r.createdAt);},"nowrap"],function(r){return esc(r.actorEmail);},function(r){return esc(r.action);},[function(r){return esc(r.deltaCredits);},"num"],function(r){return esc(r.reason);}]);
    }).catch(function(){});
  }
  function openDetail(accountId){
    currentAccountId=accountId;
    el("detail-body").innerHTML='<div class="muted-note">Loading…</div>';
    el("detail").classList.add("open"); el("detail").setAttribute("aria-hidden","false"); el("detail-scrim").classList.remove("hidden");
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
  function closeDetail(){ var d=el("detail"); if(d){ d.classList.remove("open"); d.setAttribute("aria-hidden","true"); } var s=el("detail-scrim"); if(s) s.classList.add("hidden"); }

  // --- boot: silent re-auth if a token is already stored ---
  (function boot(){ var t=getToken(); if(t){ attemptLogin(t); } else { showLogin(); } })();
`;
