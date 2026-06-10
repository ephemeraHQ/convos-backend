// Static payload for the iOS empty-state CTAs shown on the Convos and
// Things tabs for brand-new installs. The app ships the same shape
// bundled and refreshes from GET /api/v2/empty-state-mocks once per
// launch, so this payload can rotate copy and examples without an app
// release. The iOS decoder lives at
// Convos/Conversations List/Empty State/EmptyStateMocksProvider.swift
// in convos-ios.
//
// The HTML follows the artifact design system in convos-assistants
// (runtime DESIGN.md): monochrome system-typed tokens with the fixed
// light/dark mapping, 1px edge borders, generous radii, accent and
// success used sparingly, no JS or remote resources.

export type EmptyStateMockConversation = {
  id: string;
  name: string;
  emoji: string;
  messageText: string;
};

export type EmptyStateMockThing = {
  id: string;
  title: string;
  emoji: string | null;
  // Name of the mock conversation the thing came from, captioned under
  // the preview tile to tell the story of who made it together.
  conversationName: string;
  // Inline, self-contained HTML document. The app writes it to disk and
  // renders a preview image through the same WKWebView snapshot pipeline
  // used for real agent-produced files, so it should be a complete page
  // that looks good at a 160pt-wide tile and supports
  // prefers-color-scheme.
  html: string;
};

export type EmptyStateMocksPayload = {
  conversations: EmptyStateMockConversation[];
  things: EmptyStateMockThing[];
};

const DINNER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dinner suggestion</title>
<style>
  :root {
    color-scheme: light dark;
    --color-primary: #000000;
    --color-secondary: #666666;
    --color-tertiary: #B2B2B2;
    --color-surface: #FFFFFF;
    --color-muted: #F5F5F5;
    --color-edge: #EBEBEB;
    --color-accent: #FC4F37;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --color-primary: #FFFFFF;
      --color-secondary: #999999;
      --color-tertiary: #4D4D4D;
      --color-surface: #262626;
      --color-muted: #333333;
      --color-edge: #333333;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--color-muted);
    color: var(--color-primary);
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    padding: 8px;
  }
  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-edge);
    border-radius: 12px;
    padding: 12px 10px;
  }
  .hero {
    font-size: 34px;
    text-align: center;
    line-height: 1.2;
  }
  .eyebrow {
    margin-top: 8px;
    font-size: 7px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-secondary);
    text-align: center;
  }
  .eyebrow .dot { color: var(--color-accent); }
  h1 {
    margin-top: 2px;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: -0.025em;
    line-height: 1.15;
    text-align: center;
  }
  .dek {
    margin-top: 3px;
    font-size: 8px;
    line-height: 1.4;
    color: var(--color-secondary);
    text-align: center;
  }
  .badges {
    margin-top: 9px;
    display: flex;
    justify-content: center;
    gap: 4px;
  }
  .badge {
    background: var(--color-muted);
    color: var(--color-secondary);
    border-radius: 9999px;
    font-size: 7px;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 3px 7px;
    white-space: nowrap;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="hero">🌮</div>
    <p class="eyebrow"><span class="dot">●</span> Taco night</p>
    <h1>Al pastor street tacos</h1>
    <p class="dek">Pineapple salsa, charred corn tortillas, lime wedges</p>
    <div class="badges">
      <span class="badge">25 min</span>
      <span class="badge">Serves 4</span>
    </div>
  </div>
</body>
</html>
`;

const PUSHUPS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pushup tracker</title>
<style>
  :root {
    color-scheme: light dark;
    --color-primary: #000000;
    --color-secondary: #666666;
    --color-surface: #FFFFFF;
    --color-muted: #F5F5F5;
    --color-edge: #EBEBEB;
    --color-success: #16A34A;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --color-primary: #FFFFFF;
      --color-secondary: #999999;
      --color-surface: #262626;
      --color-muted: #333333;
      --color-edge: #333333;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--color-surface);
    color: var(--color-primary);
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    /* Compact: the 160pt tile overlays its title pill along the bottom
       edge, so all content must end above that band. */
    padding: 8px 12px;
  }
  .month {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-secondary);
    text-align: center;
  }
  .grid {
    margin: 8px auto 0;
    width: 112px;
    display: grid;
    grid-template-columns: repeat(7, 10px);
    justify-content: space-between;
    row-gap: 6px;
  }
  .d {
    width: 10px;
    height: 10px;
    border-radius: 9999px;
    background: var(--color-muted);
  }
  .on { background: var(--color-success); }
  .today {
    background: transparent;
    border: 1.5px solid var(--color-secondary);
  }
  .off { visibility: hidden; }
  .streaks {
    margin-top: 9px;
    display: flex;
    justify-content: space-between;
    font-size: 9px;
    font-weight: 600;
    color: var(--color-success);
    font-variant-numeric: tabular-nums;
  }
</style>
</head>
<body>
  <p class="month">May</p>
  <div class="grid">
    <span class="d off"></span><span class="d off"></span><span class="d off"></span><span class="d on"></span><span class="d on"></span><span class="d"></span><span class="d"></span>
    <span class="d on"></span><span class="d on"></span><span class="d"></span><span class="d on"></span><span class="d"></span><span class="d on"></span><span class="d on"></span>
    <span class="d"></span><span class="d on"></span><span class="d on"></span><span class="d on"></span><span class="d on"></span><span class="d on"></span><span class="d today"></span>
    <span class="d"></span><span class="d"></span><span class="d"></span><span class="d"></span><span class="d"></span><span class="d"></span><span class="d"></span>
    <span class="d"></span><span class="d"></span><span class="d"></span><span class="d"></span><span class="d"></span><span class="d off"></span><span class="d off"></span>
  </div>
  <div class="streaks">
    <span>5d streak</span>
    <span>11w streak</span>
  </div>
</body>
</html>
`;

const COUNTDOWN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trip countdown</title>
<style>
  :root {
    color-scheme: light dark;
    --color-primary: #000000;
    --color-secondary: #666666;
    --color-tertiary: #B2B2B2;
    --color-surface: #FFFFFF;
    --color-muted: #F5F5F5;
    --color-edge: #EBEBEB;
    --color-accent: #FC4F37;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --color-primary: #FFFFFF;
      --color-secondary: #999999;
      --color-tertiary: #4D4D4D;
      --color-surface: #262626;
      --color-muted: #333333;
      --color-edge: #333333;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--color-surface);
    color: var(--color-primary);
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    /* Compact: the 160pt tile overlays its title pill along the bottom
       edge, so all content must end above that band. */
    padding: 10px 12px;
    text-align: center;
  }
  .eyebrow {
    font-size: 8px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-secondary);
  }
  .eyebrow .plane { color: var(--color-accent); }
  .count {
    margin-top: 2px;
    font-size: 58px;
    font-weight: 700;
    letter-spacing: -0.025em;
    line-height: 1.05;
    font-variant-numeric: tabular-nums;
  }
  .label {
    font-size: 9px;
    font-weight: 600;
    color: var(--color-secondary);
  }
  .meta {
    margin-top: 5px;
    padding-top: 5px;
    border-top: 1px solid var(--color-edge);
    font-size: 8px;
    color: var(--color-secondary);
  }
</style>
</head>
<body>
  <p class="eyebrow"><span class="plane">✈</span> Days to departure</p>
  <div class="count">3</div>
  <p class="label">Leaves Friday</p>
  <p class="meta">PHX rental · cabin check-in 4pm</p>
</body>
</html>
`;

// Mirrors the payload bundled with the iOS app so a fresh install and a
// remote-refreshed install look identical until this list diverges on
// purpose.
export const EMPTY_STATE_MOCKS: EmptyStateMocksPayload = {
  conversations: [
    {
      id: "soccer-club",
      name: "Dunes Soccer Club",
      emoji: "⚽️",
      messageText:
        "Skipper: need 3 more RSVPs for tomorrow's match — Emily, Ray…",
    },
    {
      id: "fam",
      name: "Fam",
      emoji: "🏡",
      messageText:
        "Mealplanner: this week's dinner plan is ready — taco Tuesday is confirmed",
    },
    {
      id: "book-club",
      name: "Book Club",
      emoji: "📚",
      messageText:
        "Bookworm: reminder — we're discussing chapters 4–6 on Thursday",
    },
    {
      id: "tahoe-trip",
      name: "Tahoe Trip",
      emoji: "🏔️",
      messageText:
        "Trip Planner: cabin booked! I made a packing list for everyone",
    },
  ],
  things: [
    {
      id: "dinner-suggestion",
      title: "Dinner suggestion",
      emoji: "🌮",
      conversationName: "The Kitchen",
      html: DINNER_HTML,
    },
    {
      id: "pushup-streak",
      title: "Pushup tracker",
      emoji: "💪",
      conversationName: "Pushup Party",
      html: PUSHUPS_HTML,
    },
    {
      id: "departure-countdown",
      title: "Trip countdown",
      emoji: "✈️",
      conversationName: "Sedona Weekend",
      html: COUNTDOWN_HTML,
    },
  ],
};
