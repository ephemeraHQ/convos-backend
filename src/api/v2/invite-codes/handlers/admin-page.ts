import type { Request, Response } from "express";

/**
 * Handler for GET /api/v2/invite-codes/admin
 *
 * Serves a self-contained admin page for managing invite codes.
 * The page prompts for the admin password (DEV_API_TOKEN) and stores it
 * in sessionStorage. All API calls are made client-side with the token
 * as a Bearer header against the existing admin endpoints.
 */
export function adminPageHandler(_req: Request, res: Response) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(ADMIN_HTML);
}

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Invite Codes — Convos Admin</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f7; color: #1d1d1f; padding: 2rem; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 1.5rem; }
  h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.75rem; }

  /* Login */
  #login { max-width: 360px; margin: 4rem auto; }
  #login h1 { text-align: center; }

  /* Cards */
  .card { background: #fff; border-radius: 12px; padding: 1.25rem; margin-bottom: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }

  /* Forms */
  label { display: block; font-size: 0.85rem; font-weight: 500; margin-bottom: 0.25rem; color: #6e6e73; }
  input, select { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid #d2d2d7; border-radius: 8px; font-size: 0.95rem; margin-bottom: 0.75rem; outline: none; }
  input:focus, select:focus { border-color: #0071e3; box-shadow: 0 0 0 3px rgba(0,113,227,0.15); }
  .row { display: flex; gap: 0.75rem; }
  .row > * { flex: 1; }

  /* Buttons */
  button { padding: 0.5rem 1.25rem; border: none; border-radius: 8px; font-size: 0.9rem; font-weight: 500; cursor: pointer; transition: background 0.15s; }
  .btn-primary { background: #0071e3; color: #fff; }
  .btn-primary:hover { background: #0077ed; }
  .btn-primary:disabled { background: #a1c4e8; cursor: not-allowed; }
  .btn-secondary { background: #e8e8ed; color: #1d1d1f; }
  .btn-secondary:hover { background: #dddde1; }
  .btn-danger { background: #ff3b30; color: #fff; font-size: 0.8rem; padding: 0.35rem 0.75rem; }

  /* Table */
  .table-wrap { overflow-x: auto; margin-top: 0.5rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e8e8ed; }
  th { font-weight: 600; color: #6e6e73; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .badge-pending { background: #e8f5e9; color: #2e7d32; }
  .badge-redeemed { background: #fce4ec; color: #c62828; }

  /* Pagination */
  .pagination { display: flex; justify-content: space-between; align-items: center; margin-top: 0.75rem; font-size: 0.85rem; color: #6e6e73; }

  /* Toast */
  .toast { position: fixed; bottom: 1.5rem; right: 1.5rem; padding: 0.75rem 1.25rem; border-radius: 10px; color: #fff; font-size: 0.9rem; font-weight: 500; opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 100; }
  .toast.show { opacity: 1; }
  .toast-success { background: #34c759; }
  .toast-error { background: #ff3b30; }

  /* Generated codes output */
  .generated-codes { background: #f5f5f7; border-radius: 8px; padding: 0.75rem; margin-top: 0.5rem; font-family: "SF Mono", Monaco, monospace; font-size: 0.85rem; word-break: break-all; line-height: 1.8; }
  .generated-codes span { display: inline-block; background: #fff; padding: 0.15rem 0.5rem; border-radius: 4px; margin: 0.15rem; border: 1px solid #e8e8ed; }

  .logout { float: right; font-size: 0.8rem; }
</style>
</head>
<body>

<!-- Login -->
<div id="login">
  <h1>🔑 Invite Codes</h1>
  <div class="card">
    <label for="pw">Admin password</label>
    <input type="password" id="pw" placeholder="Enter password" autofocus>
    <button class="btn-primary" style="width:100%" onclick="doLogin()">Sign in</button>
  </div>
</div>

<!-- Main app (hidden until authed) -->
<div id="app" style="display:none">
  <h1>🔑 Invite Codes <button class="btn-secondary logout" onclick="doLogout()">Sign out</button></h1>

  <!-- Generate -->
  <div class="card">
    <h2>Generate codes</h2>
    <div class="row">
      <div>
        <label for="gen-count">Count</label>
        <input type="number" id="gen-count" value="10" min="1" max="500">
      </div>
      <div>
        <label for="gen-label">Batch label (optional)</label>
        <input type="text" id="gen-label" placeholder="e.g. beta-wave-1">
      </div>
    </div>
    <button class="btn-primary" id="gen-btn" onclick="doGenerate()">Generate</button>
    <div id="gen-output"></div>
  </div>

  <!-- List -->
  <div class="card">
    <h2>Browse codes</h2>
    <div class="row">
      <div>
        <label for="filter-status">Status</label>
        <select id="filter-status" onchange="loadCodes()">
          <option value="all">All</option>
          <option value="pending">Pending</option>
          <option value="redeemed">Redeemed</option>
        </select>
      </div>
      <div>
        <label for="filter-batch">Batch label</label>
        <input type="text" id="filter-batch" placeholder="Filter…" oninput="debounceLoad()">
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Code</th><th>Status</th><th>Batch</th><th>Created</th><th>Redeemed</th></tr></thead>
        <tbody id="codes-body"></tbody>
      </table>
    </div>
    <div class="pagination">
      <span id="page-info"></span>
      <div>
        <button class="btn-secondary" id="prev-btn" onclick="prevPage()" disabled>← Prev</button>
        <button class="btn-secondary" id="next-btn" onclick="nextPage()">Next →</button>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const PAGE_SIZE = 50;
let currentOffset = 0;
let totalCodes = 0;
let debounceTimer = null;

function token() { return sessionStorage.getItem("invite_admin_token") || ""; }

function apiBase() {
  // The admin API endpoints live under the same origin
  return window.location.origin + "/api/v2/invite-codes/admin";
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(apiBase() + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token(),
      ...(opts.headers || {}),
    },
  });
  return res;
}

function toast(msg, type = "success") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast toast-" + type + " show";
  setTimeout(() => { el.className = "toast"; }, 3000);
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Auth
async function doLogin() {
  const pw = document.getElementById("pw").value.trim();
  if (!pw) return;
  sessionStorage.setItem("invite_admin_token", pw);
  // Test the token by listing codes
  const res = await apiFetch("/codes?limit=1");
  if (res.ok) {
    showApp();
  } else {
    sessionStorage.removeItem("invite_admin_token");
    toast("Invalid password", "error");
  }
}

document.getElementById("pw").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLogin();
});

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

// On load, check if already authed
if (token()) {
  apiFetch("/codes?limit=1").then(r => { if (r.ok) showApp(); });
}

// Generate
async function doGenerate() {
  const btn = document.getElementById("gen-btn");
  const count = parseInt(document.getElementById("gen-count").value, 10) || 10;
  const label = document.getElementById("gen-label").value.trim() || undefined;
  btn.disabled = true;
  btn.textContent = "Generating…";
  try {
    const res = await apiFetch("/generate", {
      method: "POST",
      body: JSON.stringify({ count, batchLabel: label }),
    });
    const json = await res.json();
    if (res.ok && json.success) {
      const out = document.getElementById("gen-output");
      out.innerHTML = '<div class="generated-codes">' +
        json.data.codes.map(c => "<span>" + c + "</span>").join("") +
        "</div>";
      toast("Generated " + json.data.count + " codes");
      loadCodes();
    } else {
      toast(json.message || "Generation failed", "error");
    }
  } catch (e) {
    toast("Network error", "error");
  }
  btn.disabled = false;
  btn.textContent = "Generate";
}

// List
function debounceLoad() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { currentOffset = 0; loadCodes(); }, 300);
}

async function loadCodes() {
  const status = document.getElementById("filter-status").value;
  const batch = document.getElementById("filter-batch").value.trim();
  const params = new URLSearchParams({ status, limit: PAGE_SIZE, offset: currentOffset });
  if (batch) params.set("batchLabel", batch);

  try {
    const res = await apiFetch("/codes?" + params.toString());
    const json = await res.json();
    if (!res.ok) { toast(json.message || "Failed to load", "error"); return; }

    const { codes, total } = json.data;
    totalCodes = total;

    const tbody = document.getElementById("codes-body");
    if (codes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#6e6e73;padding:1.5rem">No codes found</td></tr>';
    } else {
      tbody.innerHTML = codes.map(c =>
        "<tr>" +
        "<td><code>" + c.code + "</code></td>" +
        '<td><span class="badge badge-' + c.status + '">' + c.status + "</span></td>" +
        "<td>" + (c.batchLabel || "—") + "</td>" +
        "<td>" + fmtDate(c.createdAt) + "</td>" +
        "<td>" + fmtDate(c.redeemedAt) + "</td>" +
        "</tr>"
      ).join("");
    }

    const start = total === 0 ? 0 : currentOffset + 1;
    const end = Math.min(currentOffset + PAGE_SIZE, total);
    document.getElementById("page-info").textContent = start + "–" + end + " of " + total;
    document.getElementById("prev-btn").disabled = currentOffset === 0;
    document.getElementById("next-btn").disabled = currentOffset + PAGE_SIZE >= total;
  } catch (e) {
    toast("Network error", "error");
  }
}

function prevPage() { currentOffset = Math.max(0, currentOffset - PAGE_SIZE); loadCodes(); }
function nextPage() { currentOffset += PAGE_SIZE; loadCodes(); }
</script>
</body>
</html>`;
