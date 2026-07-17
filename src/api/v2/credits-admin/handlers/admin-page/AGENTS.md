# Credits-admin console — frontend & brand guide

How the credits-admin page is built, how to keep it **in brand**, and the
gotchas that have actually bitten. Read this before adding or restyling any UI
under `src/api/v2/credits-admin/handlers/admin-page/`. Applies to agents and
humans.

The look is the convos-assistants **"Quiet Instrument"** brand: Lava accent
(`#FC4F37`), calm neutral surfaces, custom controls, light-only.

## Module map

The whole page is one server-rendered HTML document — **no framework, no build
step, no external assets**. Four files, assembled by `index.ts`
(`adminPageHandler`):

| File              | Role                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `console-view.ts` | Static HTML shell (`consoleView()`), plus `login-view.ts`. Exposes the shared inline-SVG chevron `CHEV`. |
| `script.ts`       | All client JS, returned as a **template string** by `clientScript()`. Runtime DOM lives here.            |
| `styles.ts`       | All CSS, as the `STYLES` string. Design tokens in `:root`.                                               |
| `index.ts`        | Sets CSP + assembles `<style>${STYLES}</style>` + shell + `<script nonce>${clientScript()}</script>`.    |

## Hard constraints (CSP) — these bite

`index.ts` sets: `default-src 'self'; script-src 'nonce-<nonce>'; style-src
'unsafe-inline'`. Consequences you must respect:

- **No inline event handlers.** `onclick="…"` in an HTML string is blocked. Wire
  everything with `addEventListener` (or `el(...).onclick = fn`) **inside** the
  nonce'd script.
- **No external anything** — no CDN scripts/styles/fonts, no remote images.
- **Icons are inline `<svg>`, never CSS `background-image: url(data:…)`.** A
  data-URI in CSS is **CSP-blocked** here. The chevron is the inline `CHEV` SVG;
  copy that approach for any new icon.
- **`style-src 'unsafe-inline'`** — inline `style="…"` attributes and the
  `<style>` block are fine.

## Brand system — reuse, don't reinvent

### Tokens (always use these; never hardcode a hex)

Defined in `:root` in `styles.ts`. Load-bearing ones:

- Color: `--color-brand:#FC4F37` (Lava), `--color-brand-strong` (+hover),
  `--fg` / `--fg-2` / `--fg-3` (text ramp), `--surface` / `--surface-muted` /
  `--surface-hover`, `--edge` (borders).
- Shape/space: `--radius-sm|--radius|--radius-lg|--radius-full`, `--control-h`
  (control height, keep controls uniform), `--shadow-pop` (floating panels).
- **Light-only.** `:root` holds a single light palette — there is **no dark
  theme** (no `prefers-color-scheme`, no `data-theme`). Don't add per-color dark
  handling ad hoc; if dark is ever wanted it's a deliberate, separate project.

### Components that already exist — use them

- **Dropdowns → the `.dd` component. Never ship a bare native `<select>`.** A raw
  select renders OS-grey and its open menu is OS-native (off-brand). Instead:
  ```
  <div class="dd" data-dd="NAME">
    <select id="NAME" class="dd-native"> … options … </select>
    <button class="dd-btn" aria-haspopup="listbox" aria-expanded="false">
      <span class="dd-label"></span>${CHEV}
    </button>
    <div class="dd-menu" role="listbox"></div>
  </div>
  ```
  Then call `initDropdown(el)` on it. The hidden native `<select>` stays the
  **value + wiring source** — `initDropdown` dispatches a real `change` event on
  it, so existing `change` listeners keep working. Build the option list on the
  native select; the branded menu mirrors it.
- **Floating panels (menus, tooltips, popovers): `background:var(--surface);
border:1px solid var(--edge); box-shadow:var(--shadow-pop); border-radius`.**
  Match `.dd-menu`. This is the single popover look.
- **Tooltips: never use the native `title=` attribute.** It's OS-grey chrome and
  has a ~1s hover delay. Use `data-tip="…"` + a CSS `:hover::before` (or
  `::after`) popover styled like `.dd-menu`, which is instant. (Watch collisions:
  the usage-bar peak label already uses `::after`, so the tooltip uses
  `::before`.)
- Other components: `.card`, `.btn` / `.btn-primary` / `.btn-secondary` /
  `.btn-danger`, `.pill` (status chips — **not** legacy `.badge`), `.facet`
  (filter chips), the brand SVG logo/wordmark in `console-view.ts`.

## In-brand checklist (adding or expanding UI)

1. New selector? **Use a token**, not a literal color/size.
2. A dropdown? **`.dd` + `initDropdown`**, never a bare `<select>`.
3. A floating panel? `--surface` + `--edge` + `--shadow-pop`.
4. A hover hint? `data-tip` + CSS `::before`, never `title=`.
5. An icon? Inline `<svg>`, never a CSS data-URI.
6. An interaction? `addEventListener` in `clientScript()`, never inline `on*=`.
7. Controls in a row? Keep them at `--control-h`; equal widths read as
   intentional (see Responsive).
8. **Render it and look** before calling it in-brand (see Verifying).

## Recurring gotchas / bug classes

- **Dropdowns injected after boot aren't initialized.** `initDropdown` runs once
  at load over `document.querySelectorAll(".dd")`. Anything rendered later — e.g.
  a `.dd` inside the detail modal built on click — **must be initialized
  explicitly** after injection: `Array.prototype.forEach.call(
el("detail-body").querySelectorAll(".dd"), initDropdown)`. (Per-open init
  registers one document click-listener each open — a harmless minor leak in an
  admin tool.) Programmatic `select.value = …` won't resync the branded label;
  `initDropdown` stashes `dd.__sync` for that.
- **Sharing a value between server TS and the client JS string.** The client
  script is a template string built at module load. To reuse a server const
  (e.g. `CHEV`) inside it, `export` it and inject
  `var X = ${JSON.stringify(CHEV)};` into the `clientScript()` template — don't
  duplicate the markup.
- **Async UI = commit-on-intent bug class (the one that keeps recurring here).**
  Handlers that mutate **shared** state (a shared DOM node, a cursor, a "current
  id") based on a request that a newer action already superseded will show stale
  or mixed data. Guard every async mutation on a **confirmed-current** check
  before touching shared state, using generation counters (`detailGen` for
  open/account, `ledgerGen` / `activityGen` for intra-view actions):
  - capture `gen` at dispatch; in `.then` **and `.catch`**, bail if
    `gen !== <counter>` (or the id changed) **before** any mutation;
  - **commit shared state only in the success branch** after the guard — not at
    dispatch (a failed fetch must leave the visible state consistent);
  - when an action supersedes a control (e.g. applying a filter), clear/disable
    the superseded affordance at dispatch so no interleaved action starts.
    See `applyLedgerFilter` / `loadLedgerMore` for the worked pattern.

## Responsive

Breakpoints in `styles.ts`: `max-width:768px` (single-column, full-width modal),
`max-width:600px` (filter row re-wraps), `pointer:coarse` (larger touch
targets), `prefers-reduced-motion`. Lesson: a `flex-wrap:nowrap` row that fits
desktop **shrinks controls to unusable widths and lets fixed-`min-width` popovers
overflow the viewport on narrow screens** — pair any nowrap row with a
narrow-screen media query that re-wraps and constrains popover width
(`.dd-menu{min-width:0}`).

## Verifying (structure ≠ look ≠ behavior)

- **Structure:** `tests/credits-admin/admin-page.test.ts` asserts served-HTML
  substrings (ids, classes, `data-dd`, presence of wiring functions) **and**
  `new Function(clientScript())` — the syntax check that catches template-string
  JS errors string assertions miss. Run it after any script.ts change.
- **Look:** **render it and look — don't reason about hex.** No browser runs in
  CI, so screenshot a standalone harness that pulls the real `STYLES` and runs
  the real `initDropdown` over representative markup, via headless Chrome
  (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless
--screenshot=out.png file://harness.html`). Render both wide and narrow. This
  is how brand match / layout / a tooltip is actually confirmed.
- **Behavior (render timing, hover feel, async races):** browser-walk only — the
  human gate. Static tests can't reach it; call it out in the PR test plan.

## Money correctness (not styling, but it lives here)

The admin page **reads** balances via `getBalance` / the repos and **mutates**
credits only through `@/payments` (`grant` / `adjust`). Never write
`UserCredits` / `CreditLedger` from here. Any change to the credit model must be
reflected on this page — see `src/payments/AGENTS.md`.
