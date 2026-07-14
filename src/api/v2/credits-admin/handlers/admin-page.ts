import crypto from "node:crypto";
import type { Request, Response } from "express";
import { config } from "@/payments/credits/config";

export const adminPageHandler = (_req: Request, res: Response): void => {
  const nonce = crypto.randomBytes(16).toString("base64");
  const creditsPerUsd = Number(config.creditsPerDollar);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.removeHeader("Content-Security-Policy");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`,
  );
  res.send(buildHTML(nonce, creditsPerUsd));
};

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

function buildHTML(nonce: string, creditsPerUsd: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Credits Admin — Convos</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; background: #f5f5f7; color: #1d1d1f; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  .identity { font-size: 13px; color: #6e6e73; margin-bottom: 20px; }
  .identity strong { color: #1d1d1f; }
  .card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
  input, select { width: 100%; padding: 10px; border: 1px solid #d2d2d7; border-radius: 8px; font-size: 14px; }
  button { padding: 10px 16px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .btn-primary { background: #0071e3; color: #fff; }
  .btn-danger { background: #d70015; color: #fff; }
  .btn-secondary { background: #e8e8ed; color: #1d1d1f; }
  .row { display: flex; gap: 12px; align-items: flex-end; }
  .row > * { flex: 1; }
  .hint { font-size: 12px; color: #6e6e73; margin-top: 4px; }
  .balances { display: flex; gap: 24px; flex-wrap: wrap; }
  .balance { padding: 12px 16px; border-radius: 8px; background: #f5f5f7; min-width: 160px; }
  .balance .k { font-size: 12px; color: #6e6e73; }
  .balance .v { font-size: 20px; font-weight: 700; }
  .balance.spendable { background: #e3f2e8; }
  .balance.raw { background: #eef0ff; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge-yes { background: #d1f0d6; color: #14752a; }
  .badge-no { background: #f7d6d6; color: #a3151f; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ececec; }
  th { color: #6e6e73; font-weight: 600; }
  .spark { display: flex; align-items: flex-end; gap: 2px; height: 56px; }
  .spark .bar { flex: 1 1 0; min-width: 3px; min-height: 2px; background: #0071e3; border-radius: 2px 2px 0 0; }
  .hidden { display: none; }
  .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 18px; border-radius: 8px; color: #fff; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .toast-success { background: #14752a; }
  .toast-error { background: #a3151f; }
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; }
  .modal { background: #fff; border-radius: 12px; padding: 24px; max-width: 440px; width: 90%; }
  .modal p { font-size: 14px; line-height: 1.5; }
  .modal .actions { display: flex; gap: 12px; margin-top: 20px; }
</style>
</head>
<body>
<h1>💳 Credits Admin</h1>
<div class="identity">Authenticated via admin token · <button id="clear-token" class="btn-secondary" style="padding:2px 10px;font-size:12px">Lock</button></div>

<div class="card">
  <h2>Find account</h2>
  <div class="row">
    <div style="flex:0 0 160px">
      <label for="search-key">Lookup by</label>
      <select id="search-key">
        <option value="accountId">accountId (UUID)</option>
        <option value="wallet">wallet address</option>
      </select>
    </div>
    <div>
      <label for="search-value">Value</label>
      <input id="search-value" placeholder="paste accountId or wallet">
    </div>
    <div style="flex:0 0 120px">
      <button class="btn-primary" id="search-btn" style="width:100%">Search</button>
    </div>
  </div>
</div>

<div id="detail" class="hidden">
  <div class="card">
    <h2>Account <span id="detail-id" style="font-weight:400;font-size:13px"></span></h2>
    <div class="balances">
      <div class="balance spendable"><div class="k">Spendable (derived)</div><div class="v" id="b-spendable"></div></div>
      <div class="balance raw"><div class="k">Raw parked balance</div><div class="v" id="b-raw"></div></div>
      <div class="balance"><div class="k">Entitled</div><div class="v"><span id="b-entitled"></span></div></div>
    </div>
    <div id="sub-block" style="margin-top:16px"></div>
  </div>

  <div class="card">
    <h2>Grant credits (additive)</h2>
    <div class="row">
      <div><label for="grant-credits">Credits</label><input id="grant-credits" type="number" min="1"><div class="hint" id="grant-hint"></div></div>
      <div><label for="grant-reason">Reason</label><input id="grant-reason" placeholder="required"></div>
      <div style="flex:0 0 120px"><button class="btn-primary" id="grant-btn" style="width:100%">Grant</button></div>
    </div>
  </div>

  <div class="card">
    <h2>Adjust ledger (signed correction)</h2>
    <div class="row">
      <div><label for="adjust-delta">Delta (±credits)</label><input id="adjust-delta" type="number"><div class="hint" id="adjust-hint"></div></div>
      <div><label for="adjust-reason">Reason</label><input id="adjust-reason" placeholder="required"></div>
      <div style="flex:0 0 120px"><button class="btn-danger" id="adjust-btn" style="width:100%">Adjust</button></div>
    </div>
  </div>

  <div class="card">
    <h2>Recent ledger</h2>
    <div style="overflow-x:auto"><table id="ledger-table"><thead><tr><th>When</th><th>Δ</th><th>Reason</th><th>Kind</th><th>Note</th></tr></thead><tbody></tbody></table></div>
  </div>

  <div class="card">
    <h2>Usage (last 30 days)</h2>
    <div id="usage-spark" class="spark"></div>
  </div>

  <div class="card">
    <h2>Daily refills</h2>
    <div style="overflow-x:auto"><table id="refills-table"><thead><tr><th>When</th><th>Δ</th><th>Note</th></tr></thead><tbody></tbody></table></div>
  </div>

  <div class="card">
    <h2>Admin audit log</h2>
    <div style="overflow-x:auto"><table id="audit-table"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Δ</th><th>Reason</th></tr></thead><tbody></tbody></table></div>
  </div>
</div>

<div id="modal-root"></div>
<div class="toast" id="toast"></div>

<script nonce="${nonce}">
  var CREDITS_PER_USD = ${safeScriptJson(creditsPerUsd)};
  var currentAccountId = null;

  function getToken() {
    var t = sessionStorage.getItem("credits_admin_token");
    if (!t) {
      t = window.prompt("Admin token");
      if (t) sessionStorage.setItem("credits_admin_token", t);
    }
    return t || "";
  }
  function clearToken() {
    sessionStorage.removeItem("credits_admin_token");
    toast("Token cleared", "success");
  }
  document.getElementById("clear-token").addEventListener("click", clearToken);

  function apiBase() { return window.location.origin + "/api/v2/credits-admin"; }
  function apiFetch(path, opts) {
    opts = opts || {};
    var token = getToken();
    return fetch(apiBase() + path, Object.assign({}, opts, {
      headers: Object.assign(
        { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        opts.headers || {},
      ),
    })).then(function (r) {
      if (r.status === 401) {
        sessionStorage.removeItem("credits_admin_token");
        toast("Auth failed — re-enter token", "error");
      }
      return r;
    });
  }
  function toast(msg, type) {
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.className = "toast toast-" + (type || "success") + " show";
    setTimeout(function () { el.className = "toast"; }, 3500);
  }
  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function fmtCredits(n) { return Number(n).toLocaleString(); }
  function usdHint(credits) {
    var c = Number(credits);
    if (!CREDITS_PER_USD || !isFinite(c) || !c) return "";
    var usd = c / CREDITS_PER_USD;
    return "≈ $" + usd.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function newKey(prefix) { return prefix + "_" + crypto.randomUUID(); }

  document.getElementById("grant-credits").addEventListener("input", function () {
    document.getElementById("grant-hint").textContent = usdHint(this.value);
  });
  document.getElementById("adjust-delta").addEventListener("input", function () {
    document.getElementById("adjust-hint").textContent = usdHint(Math.abs(Number(this.value)));
  });

  document.getElementById("search-btn").addEventListener("click", doSearch);
  document.getElementById("search-value").addEventListener("keydown", function (e) { if (e.key === "Enter") doSearch(); });
  function doSearch() {
    var key = document.getElementById("search-key").value;
    var value = document.getElementById("search-value").value.trim();
    if (!value) return;
    apiFetch("/search?key=" + encodeURIComponent(key) + "&value=" + encodeURIComponent(value))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.accountId) { toast("No account found", "error"); return; }
        loadAccount(j.accountId);
      })
      .catch(function () { toast("Search failed", "error"); });
  }

  function loadAccount(accountId) {
    apiFetch("/accounts/" + encodeURIComponent(accountId))
      .then(function (r) { if (!r.ok) throw new Error("not found"); return r.json(); })
      .then(function (j) { currentAccountId = accountId; renderDetail(j); loadAudit(accountId); })
      .catch(function () { toast("Account not found", "error"); });
  }

  function renderDetail(j) {
    document.getElementById("detail").classList.remove("hidden");
    document.getElementById("detail-id").textContent = j.accountId;
    document.getElementById("b-spendable").textContent = fmtCredits(j.spendableCredits);
    document.getElementById("b-raw").textContent = fmtCredits(j.rawBalanceCredits);
    document.getElementById("b-entitled").innerHTML = j.isEntitled
      ? '<span class="badge badge-yes">entitled</span>'
      : '<span class="badge badge-no">not entitled</span>';
    var sb = document.getElementById("sub-block");
    if (j.subscription) {
      var s = j.subscription;
      sb.innerHTML = "<table><tbody>" +
        "<tr><th>Tier</th><td>" + esc(s.tier) + "</td></tr>" +
        "<tr><th>Stored status</th><td>" + esc(s.storedStatus) + "</td></tr>" +
        "<tr><th>Effective status</th><td>" + esc(s.effectiveStatus) + "</td></tr>" +
        "<tr><th>Period</th><td>" + fmtDate(s.currentPeriodStart) + " → " + fmtDate(s.currentPeriodEnd) + "</td></tr>" +
        "<tr><th>Environment</th><td>" + esc(s.environment) + "</td></tr>" +
        "<tr><th>Period consumes</th><td>" + fmtCredits(j.periodConsumesCredits) + " credits</td></tr>" +
        "</tbody></table>";
    } else {
      sb.innerHTML = '<div class="hint">No subscription on record.</div>';
    }
    var lt = document.querySelector("#ledger-table tbody");
    lt.innerHTML = (j.ledger || []).map(function (r) {
      return "<tr><td>" + fmtDate(r.createdAt) + "</td><td>" + esc(r.delta) + "</td><td>" + esc(r.reason) + "</td><td>" + esc(r.grantKindId || "—") + "</td><td>" + esc(r.note || "") + "</td></tr>";
    }).join("");

    var refills = j.dailyRefills || [];
    var ft = document.querySelector("#refills-table tbody");
    ft.innerHTML = refills.length
      ? refills.map(function (r) {
          return "<tr><td>" + fmtDate(r.createdAt) + "</td><td>" + esc(r.delta) + "</td><td>" + esc(r.note || "") + "</td></tr>";
        }).join("")
      : '<tr><td colspan="3" class="hint">No daily refills.</td></tr>';

    var usage = j.usageDaily || [];
    var spark = document.getElementById("usage-spark");
    if (!usage.length) {
      spark.innerHTML = '<span class="hint">No usage in the last 30 days.</span>';
    } else {
      var maxUsage = usage.reduce(function (m, u) {
        var c = Number(u.consumed);
        return c > m ? c : m;
      }, 0);
      spark.innerHTML = usage.map(function (u) {
        var c = Number(u.consumed);
        var h = maxUsage > 0 ? Math.max(2, Math.round((c / maxUsage) * 100)) : 2;
        var title = esc(u.bucketStart + " · " + fmtCredits(u.consumed) + " credits");
        return '<div class="bar" style="height:' + h + '%" title="' + title + '"></div>';
      }).join("");
    }
  }

  function loadAudit(accountId) {
    apiFetch("/audit?accountId=" + encodeURIComponent(accountId))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var at = document.querySelector("#audit-table tbody");
        at.innerHTML = (j.audit || []).map(function (r) {
          return "<tr><td>" + fmtDate(r.createdAt) + "</td><td>" + esc(r.actorEmail) + "</td><td>" + esc(r.action) + "</td><td>" + esc(r.deltaCredits) + "</td><td>" + esc(r.reason) + "</td></tr>";
        }).join("");
      })
      .catch(function () { toast("Audit load failed", "error"); });
  }

  function confirmModal(message, onConfirm) {
    var root = document.getElementById("modal-root");
    root.innerHTML = '<div class="modal-bg"><div class="modal"><p>' + message + '</p>' +
      '<div class="actions"><button class="btn-secondary" id="modal-cancel" style="flex:1">Cancel</button>' +
      '<button class="btn-primary" id="modal-confirm" style="flex:1">Confirm</button></div></div></div>';
    function close() { root.innerHTML = ""; }
    document.getElementById("modal-cancel").addEventListener("click", close);
    var confirmBtn = document.getElementById("modal-confirm");
    confirmBtn.addEventListener("click", function () {
      confirmBtn.disabled = true;
      onConfirm(close);
    });
  }

  document.getElementById("grant-btn").addEventListener("click", function () {
    if (!currentAccountId) return;
    var credits = parseInt(document.getElementById("grant-credits").value, 10);
    var reason = document.getElementById("grant-reason").value.trim();
    if (!credits || credits <= 0) { toast("Enter a positive credit amount", "error"); return; }
    if (!reason) { toast("Reason is required", "error"); return; }
    var key = newKey("admin_grant");
    confirmModal(
      "Grant <strong>" + fmtCredits(credits) + "</strong> credits " + esc(usdHint(credits)) +
      " to <code>" + esc(currentAccountId) + "</code>.<br>Reason: " + esc(reason),
      function (close) {
        apiFetch("/accounts/" + encodeURIComponent(currentAccountId) + "/grant", {
          method: "POST",
          body: JSON.stringify({ credits: credits, reason: reason, idempotencyKey: key })
        }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            close();
            if (!res.ok) { toast(res.j.code === "idempotency_mismatch" ? "Idempotency mismatch" : "Grant failed", "error"); return; }
            toast(res.j.replayed ? "Already applied (idempotent)" : "Granted", "success");
            loadAccount(currentAccountId);
          }).catch(function () { close(); toast("Grant failed", "error"); });
      }
    );
  });

  document.getElementById("adjust-btn").addEventListener("click", function () {
    if (!currentAccountId) return;
    var delta = parseInt(document.getElementById("adjust-delta").value, 10);
    var reason = document.getElementById("adjust-reason").value.trim();
    if (!delta) { toast("Enter a non-zero delta", "error"); return; }
    if (!reason) { toast("Reason is required", "error"); return; }
    var key = newKey("admin_adjust");
    confirmModal(
      "Adjust ledger by <strong>" + (delta > 0 ? "+" : "") + fmtCredits(delta) + "</strong> credits " + esc(usdHint(Math.abs(delta))) +
      " on <code>" + esc(currentAccountId) + "</code>.<br>Reason: " + esc(reason),
      function (close) {
        apiFetch("/accounts/" + encodeURIComponent(currentAccountId) + "/adjust", {
          method: "POST",
          body: JSON.stringify({ delta: delta, reason: reason, idempotencyKey: key })
        }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            close();
            if (!res.ok) {
              var msg = res.j.code === "insufficient_balance" ? "Below minimum balance floor" :
                        res.j.code === "idempotency_mismatch" ? "Idempotency mismatch" : "Adjust failed";
              toast(msg, "error"); return;
            }
            toast(res.j.replayed ? "Already applied (idempotent)" : "Adjusted", "success");
            loadAccount(currentAccountId);
          }).catch(function () { close(); toast("Adjust failed", "error"); });
      }
    );
  });
</script>
</body>
</html>`;
}
