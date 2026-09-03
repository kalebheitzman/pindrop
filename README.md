# Pindrop

**Drop-in design annotation tool for any website.**  
Drop pins on the page and have threaded conversations — all wired to your own free Supabase database.

![Pindrop in action](screenshot.png)

---

## Features

- 📍 **Pins** — click anywhere to drop a numbered pin with a comment
- 💬 **Threaded replies** — comment on any annotation
- ✏️ **Edit** — update your own comments and replies inline
- ✓ **Resolve** — mark feedback as done; resolved items collapse automatically
- 🗑️ **Delete** — ownership via your account or localStorage token
- 🎯 **Focus mode** — click any annotation to dim everything else
- 📐 **Element anchoring** — pins reposition as the layout reflows (resize, rotation, or content changes), and flag themselves as approximate rather than jumping to the wrong spot when their anchored element is hidden at the current screen size
- 🔴 **Live cursors** — see other reviewers' cursors in real time
- 👁️ **Presence** — viewer count shows how many people are on the page
- 🔔 **Webhooks** — POST to any URL on new annotation or reply (Teams, Slack, Zapier…)
- ⚠️ **Page-change awareness** — annotations flagged as outdated when the page content around them changes
- ⌨️ **Keyboard shortcuts** — T = toolbar, P = pin, A = annotations, Shift+Enter = submit, Esc = cancel
- 🔒 **Your data** — everything goes to your own Supabase project
- 🔑 **Identity** — sign in with your email via magic link; ownership and admin status persist across devices
- 👑 **Admin** — admins can delete any annotation regardless of who posted it

---

## Setup

### 1. Create your Supabase tables

Go to your [Supabase](https://supabase.com) project → SQL Editor → paste and run `supabase-setup.sql`.

### 2. Get your credentials

In Supabase: **Settings → API**
- Copy the **Project URL**
- Copy the **anon / public** key (under "Legacy anon, service_role API keys" if needed)

### 3. Add one script tag

```html
<script
  src="https://cdn.jsdelivr.net/gh/kalebheitzman/pindrop@0.9.5/pindrop.min.js"
  data-supabase-url="https://YOUR_PROJECT_ID.supabase.co"
  data-supabase-key="eyJ..."
  defer
></script>
```

That's it. A ✏️ button appears in the bottom-right corner.

---

## Options

| Attribute | Default | Description |
|-----------|---------|-------------|
| `data-supabase-url` | *(required)* | Your Supabase project URL |
| `data-supabase-key` | *(required)* | Your Supabase anon/public key |
| `data-page-key` | `window.location.pathname` | Custom identifier for this page |
| `data-position` | `bottom-right` | Toggle button corner: `bottom-right` or `bottom-left` |
| `data-webhook-url` | *(none)* | URL to POST to on new annotation or reply |

---

## Keyboard Shortcuts

Shortcuts are ignored when focus is in an input or textarea.

| Key | Action |
|-----|--------|
| `T` | Toggle the toolbar panel open/closed |
| `P` | Toggle pin mode |
| `A` | Toggle the annotations sidebar |
| `Shift+Enter` | Submit a comment or reply |
| `Esc` | Cancel current action / close sidebar |

---

## Webhooks

Add `data-webhook-url` to your script tag and Pindrop will POST a JSON payload to that URL whenever an annotation or reply is created. Works with Microsoft Teams (Power Automate), Slack, Discord, Zapier, Make, n8n, or any endpoint that accepts a POST.

**Annotation payload:**
```json
{
  "event": "annotation.created",
  "page_url": "/some/path",
  "annotation": { "id": "...", "type": "pin", "comment": "...", "author_name": "...", ... }
}
```

**Reply payload:**
```json
{
  "event": "reply.created",
  "page_url": "/some/path",
  "annotation_id": "...",
  "reply": { "id": "...", "comment": "...", "author_name": "...", ... }
}
```

---

## Identity & Admin

Pindrop supports persistent identity via Supabase Auth magic links — no passwords ever. On first visit, enter your email and click the link that arrives in your inbox. Your name, ownership, and admin status follow you across devices and browsers.

### Setup

1. In your Supabase project go to **Authentication → URL Configuration**
   - Set **Site URL** to your production site (e.g. `https://yoursite.com`)
   - Add any dev environments to **Additional Redirect URLs** (e.g. `http://127.0.0.1:8000/*`)

2. To grant admin access to a user, set `is_admin = true` on their row in the `pindrop_profiles` table via the Supabase dashboard.

### Using the Account panel

Open the ✏️ toolbar. At the bottom you'll see an **Account** section:

- **Signed out** — enter your email and click "Send magic link", then click the link in your email
- **Signed in** — your email is shown with a Sign out button; admin users see a 👑 badge and can delete any annotation regardless of who posted it

Sign-in state is stored in your browser by Supabase Auth. Closing the tab doesn't sign you out — use the Sign out button when done.

---

## How it works

Pindrop is a single self-contained JavaScript file with no build step and no framework dependencies. It lazy-loads the Supabase JS client from jsDelivr, then wires everything up — toolbar, popover, sidebar — entirely in vanilla JS.

**Anonymous ownership** — on first visit a random token is generated and stored in `localStorage`. This token is saved with every annotation you create, and the Delete button only appears on annotations that match your token.

**Element anchoring** — pins store a CSS selector path to the DOM element they were placed on, plus a percentage offset within that element. The pin's position is re-derived from that selector and offset on load and whenever the layout might have changed — a window resize, an orientation change, or a `ResizeObserver`-detected reflow such as a lazy image finishing load or a web font swapping in — rather than using fixed pixel coordinates. If the anchored element is missing, or collapsed to zero size because it's hidden at the current screen size (common with responsive layouts that swap markup by breakpoint), the pin keeps its last known position instead of jumping to the top-left corner, and renders with a dashed outline (`pd-pin-approx`) plus an "Approx." badge in the sidebar so it's clear the position isn't confirmed at that viewport.

**Page-change awareness** — when a pin is created, Pindrop captures a lightweight DOM fingerprint: the text content of the pinned element. On every load it recomputes the fingerprint and compares it to the stored value. If it differs — the element's text changed — the annotation is marked with a ⚠ Outdated badge in the sidebar so reviewers know the feedback may no longer apply to that exact spot.

---

## License

MIT + Commons Clause — free to use on any project, but you may not sell Pindrop or a product whose value derives substantially from it.
