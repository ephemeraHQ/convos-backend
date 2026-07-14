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
  function loadActivity(reset){ /* Task 5 */ }
  function openDetail(accountId){ /* Task 6 */ }
  function closeDetail(){ var d=el("detail"); if(d){ d.classList.remove("open"); d.setAttribute("aria-hidden","true"); } var s=el("detail-scrim"); if(s) s.classList.add("hidden"); }

  // --- boot: silent re-auth if a token is already stored ---
  (function boot(){ var t=getToken(); if(t){ attemptLogin(t); } else { showLogin(); } })();
`;
