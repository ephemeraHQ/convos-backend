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
    var qs="?action="+encodeURIComponent(activityAction)+(activityCursor?("&cursor="+encodeURIComponent(activityCursor)):"");
    guardFetch("/audit/recent"+qs).then(function(r){ return r.json(); }).then(function(j){
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
  function openDetail(accountId){ /* Task 6 */ }
  function closeDetail(){ var d=el("detail"); if(d){ d.classList.remove("open"); d.setAttribute("aria-hidden","true"); } var s=el("detail-scrim"); if(s) s.classList.add("hidden"); }

  // --- boot: silent re-auth if a token is already stored ---
  (function boot(){ var t=getToken(); if(t){ attemptLogin(t); } else { showLogin(); } })();
`;
