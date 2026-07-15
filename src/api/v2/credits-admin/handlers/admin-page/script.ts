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

  function attemptLogin(token){
    setToken(token);
    return fetch(apiBase()+"/whoami",{headers:{"Authorization":"Bearer "+token}})
      .then(function(r){ if(r.status!==200){ throw new Error(r.status===401?"Invalid token":"Auth unavailable ("+r.status+")"); } return r.json(); })
      .then(function(j){ applyWhoami(j); showConsole(); loadActivity(true); })
      .catch(function(err){ clearToken(); showLogin(err.message||"Login failed"); });
  }

  function lock(){ clearToken(); showLogin("Locked"); }

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
        +"<td>"+fmtDate(r.createdAt)+"</td><td>"+esc(r.actorEmail)+"</td><td>"+esc(shortId(r.accountId))
        +"</td><td>"+esc(r.action)+"</td><td>"+esc(r.deltaCredits)+"</td><td>"+esc(r.reason)+"</td></tr>";
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
      renderActivityRows(j.rows||[], !reset);
      activityCursor=j.nextCursor;
      el("load-more").classList.toggle("hidden", !j.nextCursor);
      var empty = reset && (!j.rows || j.rows.length===0);
      el("activity-empty").classList.toggle("hidden", !empty);
    }).catch(function(e){ if(e.message!=="reauth") toast("Failed to load activity","error"); });
  }
  el("load-more").addEventListener("click", function(){ loadActivity(false); });
  Array.prototype.forEach.call(document.querySelectorAll(".facet"), function(f){
    f.addEventListener("click", function(){
      Array.prototype.forEach.call(document.querySelectorAll(".facet"), function(x){ x.classList.remove("active"); });
      f.classList.add("active");
      activityAction=f.getAttribute("data-action");
      loadActivity(true);
    });
  });
  function doSearch(){
    var key=el("search-key").value, value=el("search-value").value.trim();
    if(!value) return;
    guardFetch("/search?key="+encodeURIComponent(key)+"&value="+encodeURIComponent(value))
      .then(function(r){ return r.json(); })
      .then(function(j){ if(!j.accountId){ toast("No account found","error"); return; } openDetail(j.accountId); })
      .catch(function(e){ if(e.message!=="reauth") toast("Search failed","error"); });
  }
  el("search-btn").addEventListener("click", doSearch);
  el("search-value").addEventListener("keydown", function(e){ if(e.key==="Enter") doSearch(); });
  var currentAccountId=null;
  function subChip(j){
    var state=j.subscription?j.subscription.effectiveStatus:"none";
    var cls=!j.subscription?"badge-none":(j.isEntitled?"badge-yes":"badge-no");
    return '<span class="badge '+cls+'">'+esc(state)+"</span>";
  }
  function renderSpark(usage){
    if(!usage||!usage.length) return '<span style="color:var(--muted)">No usage in the last 30 days.</span>';
    var max=usage.reduce(function(m,u){ var c=Number(u.consumed); return c>m?c:m; },0);
    return usage.map(function(u){ var c=Number(u.consumed); var h=max>0?Math.max(2,Math.round(c/max*100)):2;
      return '<div class="bar" style="height:'+h+'%" title="'+esc(u.bucketStart+" · "+fmtCredits(u.consumed)+" credits")+'"></div>'; }).join("");
  }
  function rowsHtml(rows, cols){
    return (rows||[]).map(function(r){ return "<tr>"+cols.map(function(c){ return "<td>"+c(r)+"</td>"; }).join("")+"</tr>"; }).join("");
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
      : '<div style="color:var(--muted)">No subscription on record.</div>';
    el("detail-body").innerHTML =
      '<h2 style="font-size:16px">Account '+esc(shortId(j.accountId))+'</h2>'
      +'<div class="card"><div class="k">Balance</div><div style="font-size:22px;font-weight:700">'+fmtCredits(j.balanceCredits)+'</div>'
      +'<div class="k">'+usdHint(j.balanceCredits)+'</div>'
      +'<div style="margin-top:6px">Subscription: '+subChip(j)+'</div></div>'
      +'<div class="card">'+subBlock+'</div>'
      +'<div class="card"><h3>Grant</h3><input id="d-grant-credits" type="number" min="1" placeholder="credits"><input id="d-grant-reason" placeholder="reason"><button id="d-grant-btn" class="btn btn-primary">Grant</button></div>'
      +'<div class="card"><h3>Adjust</h3><input id="d-adjust-delta" type="number" placeholder="±credits"><input id="d-adjust-reason" placeholder="reason"><button id="d-adjust-btn" class="btn btn-danger">Adjust</button></div>'
      +'<div class="card"><h3>Usage (30d)</h3><div id="usage-spark" class="spark"></div></div>'
      +'<div class="card"><h3>Daily refills</h3><div class="tablewrap"><table><tbody id="d-refills"></tbody></table></div></div>'
      +'<div class="card"><h3>Recent ledger</h3><div class="tablewrap"><table><tbody id="d-ledger"></tbody></table></div></div>'
      +'<div class="card"><h3>Admin audit</h3><div class="tablewrap"><table><tbody id="d-audit"></tbody></table></div></div>';
    el("usage-spark").innerHTML = renderSpark(j.usageDaily);
    el("d-refills").innerHTML = (j.dailyRefills&&j.dailyRefills.length)
      ? rowsHtml(j.dailyRefills,[function(r){return fmtDate(r.createdAt);},function(r){return esc(r.delta);},function(r){return esc(r.note||"");}])
      : '<tr><td style="color:var(--muted)">No daily refills.</td></tr>';
    el("d-ledger").innerHTML = rowsHtml(j.ledger,[function(r){return fmtDate(r.createdAt);},function(r){return esc(r.delta);},function(r){return esc(r.reason);},function(r){return esc(r.grantKindId||"—");},function(r){return esc(r.note||"");}]);
    el("d-grant-btn").addEventListener("click", function(){ mutate("grant"); });
    el("d-adjust-btn").addEventListener("click", function(){ mutate("adjust"); });
  }
  function loadAudit(accountId){
    guardFetch("/audit?accountId="+encodeURIComponent(accountId)).then(function(r){ return r.json(); }).then(function(j){
      el("d-audit").innerHTML = rowsHtml(j.audit,[function(r){return fmtDate(r.createdAt);},function(r){return esc(r.actorEmail);},function(r){return esc(r.action);},function(r){return esc(r.deltaCredits);},function(r){return esc(r.reason);}]);
    }).catch(function(){});
  }
  function openDetail(accountId){
    currentAccountId=accountId;
    el("detail-body").innerHTML='<div style="color:var(--muted)">Loading…</div>';
    el("detail").classList.add("open"); el("detail").setAttribute("aria-hidden","false"); el("detail-scrim").classList.remove("hidden");
    guardFetch("/accounts/"+encodeURIComponent(accountId)).then(function(r){ if(r.status===404){ throw new Error("not_found"); } return r.json(); })
      .then(function(j){ renderDetail(j); loadAudit(accountId); })
      .catch(function(e){ if(e.message==="not_found"){ el("detail-body").innerHTML='<div class="badge badge-no">Account not found</div>'; } else if(e.message!=="reauth"){ toast("Failed to load account","error"); } });
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
