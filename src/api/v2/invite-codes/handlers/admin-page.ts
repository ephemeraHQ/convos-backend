import crypto from "node:crypto";
import type { Request, Response } from "express";

/**
 * Handler for GET /api/v2/invite-codes/admin
 *
 * Serves a self-contained admin page for managing invite codes.
 * The page prompts for the admin password (DEV_API_TOKEN) and stores it
 * in sessionStorage. All API calls are made client-side with the token
 * as a Bearer header against the existing admin endpoints.
 *
 * A per-request nonce is generated for CSP so inline scripts are allowed
 * without resorting to 'unsafe-inline'.
 */
export function adminPageHandler(_req: Request, res: Response) {
  const nonce = crypto.randomBytes(16).toString("base64");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // Override helmet's CSP — only our nonced script and inline styles are allowed
  res.removeHeader("Content-Security-Policy");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`,
  );
  res.send(buildHTML(nonce));
}

function buildHTML(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Invite Codes — Convos Admin</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f7; color: #1d1d1f; padding: 2rem; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 1.5rem; }
  h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.75rem; }
  #login { max-width: 360px; margin: 4rem auto; }
  #login h1 { text-align: center; }
  .card { background: #fff; border-radius: 12px; padding: 1.25rem; margin-bottom: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  label { display: block; font-size: 0.85rem; font-weight: 500; margin-bottom: 0.25rem; color: #6e6e73; }
  input, select { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid #d2d2d7; border-radius: 8px; font-size: 0.95rem; margin-bottom: 0.75rem; outline: none; }
  input:focus, select:focus { border-color: #0071e3; box-shadow: 0 0 0 3px rgba(0,113,227,0.15); }
  .row { display: flex; gap: 0.75rem; }
  .row > * { flex: 1; }
  button { padding: 0.5rem 1.25rem; border: none; border-radius: 8px; font-size: 0.9rem; font-weight: 500; cursor: pointer; transition: background 0.15s; }
  .btn-primary { background: #0071e3; color: #fff; }
  .btn-primary:hover { background: #0077ed; }
  .btn-primary:disabled { background: #a1c4e8; cursor: not-allowed; }
  .btn-secondary { background: #e8e8ed; color: #1d1d1f; }
  .btn-secondary:hover { background: #dddde1; }
  .table-wrap { overflow-x: auto; margin-top: 0.5rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e8e8ed; }
  th { font-weight: 600; color: #6e6e73; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .badge-pending { background: #e8f5e9; color: #2e7d32; }
  .badge-redeemed { background: #fce4ec; color: #c62828; }
  .pagination { display: flex; justify-content: space-between; align-items: center; margin-top: 0.75rem; font-size: 0.85rem; color: #6e6e73; }
  .toast { position: fixed; bottom: 1.5rem; right: 1.5rem; padding: 0.75rem 1.25rem; border-radius: 10px; color: #fff; font-size: 0.9rem; font-weight: 500; opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 100; }
  .toast.show { opacity: 1; }
  .toast-success { background: #34c759; }
  .toast-error { background: #ff3b30; }
  .generated-codes { background: #f5f5f7; border-radius: 8px; padding: 0.75rem; margin-top: 0.5rem; font-family: "SF Mono", Monaco, monospace; font-size: 0.85rem; word-break: break-all; line-height: 1.8; }
  .generated-codes span { display: inline-block; background: #fff; padding: 0.15rem 0.5rem; border-radius: 4px; margin: 0.15rem; border: 1px solid #e8e8ed; }
  .logout { float: right; font-size: 0.8rem; }
</style>
</head>
<body>

<div id="login">
  <h1>🔑 Invite Codes</h1>
  <div class="card">
    <label for="pw">Admin password</label>
    <input type="password" id="pw" placeholder="Enter password" autofocus>
    <button class="btn-primary" style="width:100%" id="login-btn">Sign in</button>
  </div>
</div>

<div id="app" style="display:none">
  <h1>🔑 Invite Codes <button class="btn-secondary logout" id="logout-btn">Sign out</button></h1>

  <div class="card">
    <h2>Generate codes</h2>
    <div class="row">
      <div>
        <label for="gen-count">Count</label>
        <input type="number" id="gen-count" value="1" min="1" max="500">
      </div>
      <div>
        <label for="gen-max-redemptions">Max redemptions</label>
        <input type="number" id="gen-max-redemptions" value="5" min="1">
      </div>
    </div>
    <div class="row">
      <div>
        <label for="gen-name">Name (optional)</label>
        <input type="text" id="gen-name" placeholder="e.g. VIP invite">
      </div>
      <div>
        <label for="gen-label">Batch label (optional)</label>
        <input type="text" id="gen-label" placeholder="e.g. beta-wave-1">
      </div>
    </div>
    <button class="btn-primary" id="gen-btn">Generate</button>
    <div id="gen-output"></div>
  </div>

  <div class="card">
    <h2>Browse codes</h2>
    <div class="row">
      <div>
        <label for="filter-status">Status</label>
        <select id="filter-status">
          <option value="all">All</option>
          <option value="pending">Pending</option>
          <option value="redeemed">Redeemed</option>
        </select>
      </div>
      <div>
        <label for="filter-batch">Batch label</label>
        <input type="text" id="filter-batch" placeholder="Filter…">
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Redemptions</th><th>Batch</th><th>Parent</th><th>Created</th><th>Redeemed</th></tr></thead>
        <tbody id="codes-body"></tbody>
      </table>
    </div>
    <div class="pagination">
      <span id="page-info"></span>
      <div>
        <button class="btn-secondary" id="prev-btn" disabled>← Prev</button>
        <button class="btn-secondary" id="next-btn">Next →</button>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script nonce="${nonce}">
(function () {
  var PAGE_SIZE = 50;
  var currentOffset = 0;
  var debounceTimer = null;

  function token() { return sessionStorage.getItem("invite_admin_token") || ""; }
  function apiBase() { return window.location.origin + "/api/v2/invite-codes/admin"; }

  function apiFetch(path, opts) {
    opts = opts || {};
    return fetch(apiBase() + path, Object.assign({}, opts, {
      headers: Object.assign({
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token()
      }, opts.headers || {})
    }));
  }

  function toast(msg, type) {
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.className = "toast toast-" + (type || "success") + " show";
    setTimeout(function () { el.className = "toast"; }, 3000);
  }

  function esc(s) {
    if (!s) return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // --- Auth ---
  function doLogin() {
    var pw = document.getElementById("pw").value.trim();
    if (!pw) return;
    sessionStorage.setItem("invite_admin_token", pw);
    apiFetch("/codes?limit=1").then(function (res) {
      if (res.ok) { showApp(); }
      else { sessionStorage.removeItem("invite_admin_token"); toast("Invalid password", "error"); }
    }).catch(function () { sessionStorage.removeItem("invite_admin_token"); toast("Network error", "error"); });
  }

  function doLogout() {
    sessionStorage.removeItem("invite_admin_token");
    document.getElementById("app").style.display = "none";
    document.getElementById("login").style.display = "block";
    document.getElementById("pw").value = "";
  }

  function showApp() {
    document.getElementById("login").style.display = "none";
    document.getElementById("app").style.display = "block";
    loadCodes();
  }

  // --- Generate ---
  function doGenerate() {
    var btn = document.getElementById("gen-btn");
    var count = parseInt(document.getElementById("gen-count").value, 10) || 1;
    var maxRedemptions = parseInt(document.getElementById("gen-max-redemptions").value, 10) || 5;
    var name = document.getElementById("gen-name").value.trim() || undefined;
    var label = document.getElementById("gen-label").value.trim() || undefined;
    btn.disabled = true;
    btn.textContent = "Generating…";
    apiFetch("/generate", {
      method: "POST",
      body: JSON.stringify({ count: count, batchLabel: label, name: name, maxRedemptions: maxRedemptions })
    }).then(function (res) { return res.json().then(function (json) { return { ok: res.ok, json: json }; }); })
      .then(function (r) {
        if (r.ok && r.json.success) {
          var out = document.getElementById("gen-output");
          out.textContent = "";
          var wrap = document.createElement("div");
          wrap.className = "generated-codes";
          r.json.data.codes.forEach(function (c) {
            var span = document.createElement("span");
            span.textContent = c;
            wrap.appendChild(span);
          });
          out.appendChild(wrap);
          toast("Generated " + r.json.data.count + " codes");
          loadCodes();
        } else {
          toast(r.json.message || "Generation failed", "error");
        }
      }).catch(function () { toast("Network error", "error"); })
      .finally(function () { btn.disabled = false; btn.textContent = "Generate"; });
  }

  // --- List ---
  function loadCodes() {
    var status = document.getElementById("filter-status").value;
    var batch = document.getElementById("filter-batch").value.trim();
    var params = new URLSearchParams({ status: status, limit: PAGE_SIZE, offset: currentOffset });
    if (batch) params.set("batchLabel", batch);

    apiFetch("/codes?" + params.toString())
      .then(function (res) { return res.json().then(function (json) { return { ok: res.ok, json: json }; }); })
      .then(function (r) {
        if (!r.ok) { toast(r.json.message || "Failed to load", "error"); return; }
        var codes = r.json.data.codes;
        var total = r.json.data.total;
        var tbody = document.getElementById("codes-body");
        tbody.textContent = "";
        if (codes.length === 0) {
          var emptyRow = document.createElement("tr");
          var emptyCell = document.createElement("td");
          emptyCell.colSpan = 8;
          emptyCell.style.cssText = "text-align:center;color:#6e6e73;padding:1.5rem";
          emptyCell.textContent = "No codes found";
          emptyRow.appendChild(emptyCell);
          tbody.appendChild(emptyRow);
        } else {
          codes.forEach(function (c) {
            var tr = document.createElement("tr");

            var tdCode = document.createElement("td");
            var codeEl = document.createElement("code");
            codeEl.textContent = c.code;
            tdCode.appendChild(codeEl);
            tr.appendChild(tdCode);

            var tdName = document.createElement("td");
            tdName.textContent = c.name || "\u2014";
            tr.appendChild(tdName);

            var tdStatus = document.createElement("td");
            var badge = document.createElement("span");
            badge.classList.add("badge", "badge-" + c.status);
            badge.textContent = c.status;
            tdStatus.appendChild(badge);
            tr.appendChild(tdStatus);

            var tdRedemptions = document.createElement("td");
            tdRedemptions.textContent = c.redemptionCount + " / " + c.maxRedemptions;
            tr.appendChild(tdRedemptions);

            var tdBatch = document.createElement("td");
            tdBatch.textContent = c.batchLabel || "\u2014";
            tr.appendChild(tdBatch);

            var tdParent = document.createElement("td");
            if (c.parentCode) {
              var parentEl = document.createElement("code");
              parentEl.textContent = c.parentCode;
              tdParent.appendChild(parentEl);
            } else {
              tdParent.textContent = "\u2014";
            }
            tr.appendChild(tdParent);

            var tdCreated = document.createElement("td");
            tdCreated.textContent = fmtDate(c.createdAt);
            tr.appendChild(tdCreated);

            var tdRedeemed = document.createElement("td");
            tdRedeemed.textContent = fmtDate(c.redeemedAt);
            tr.appendChild(tdRedeemed);

            tbody.appendChild(tr);
          });
        }
        var start = total === 0 ? 0 : currentOffset + 1;
        var end = Math.min(currentOffset + PAGE_SIZE, total);
        document.getElementById("page-info").textContent = start + "–" + end + " of " + total;
        document.getElementById("prev-btn").disabled = currentOffset === 0;
        document.getElementById("next-btn").disabled = currentOffset + PAGE_SIZE >= total;
      }).catch(function () { toast("Network error", "error"); });
  }

  // --- Event listeners ---
  document.getElementById("login-btn").addEventListener("click", doLogin);
  document.getElementById("pw").addEventListener("keydown", function (e) { if (e.key === "Enter") doLogin(); });
  document.getElementById("logout-btn").addEventListener("click", doLogout);
  document.getElementById("gen-btn").addEventListener("click", doGenerate);
  document.getElementById("filter-status").addEventListener("change", function () { currentOffset = 0; loadCodes(); });
  document.getElementById("filter-batch").addEventListener("input", function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { currentOffset = 0; loadCodes(); }, 300);
  });
  document.getElementById("prev-btn").addEventListener("click", function () { currentOffset = Math.max(0, currentOffset - PAGE_SIZE); loadCodes(); });
  document.getElementById("next-btn").addEventListener("click", function () { currentOffset += PAGE_SIZE; loadCodes(); });

  // Auto-login if session still valid
  if (token()) {
    apiFetch("/codes?limit=1").then(function (r) { if (r.ok) showApp(); });
  }
})();
</script>
</body>
</html>`;
}
