# Pindrop Roadmap

A living document tracking what's done, what's next, and what's planned.

---

## v0.1.x — Foundation ✓

- [x] Pin annotations with comments
- [x] Freehand drawing *(removed in v0.9.3)*
- [x] Text highlight annotations *(removed in v0.9.3)*
- [x] Threaded replies
- [x] Resolve / collapse annotations
- [x] Delete (anonymous ownership via localStorage token)
- [x] Focus / dim mode
- [x] Element anchoring (pins reposition across screen sizes) *(had real gaps on resize and mobile — fixed in v0.9.3)*
- [x] Name prompt on first load
- [x] Drop-in script tag install (`data-supabase-url`, `data-supabase-key`)
- [x] 10-color palette

---

## v0.2.x — Edit & Undo ✓

- [x] Edit a comment or reply after posting
- [x] Drawing undo (Ctrl+Z removes last stroke) *(removed in v0.9.3 along with drawing)*
- [x] Keyboard shortcuts (P = pin, D = draw, H = highlight, Esc = cancel) *(D/H removed in v0.9.3)*

---

## v0.3.0 — Real-time Collaboration ✓

- [x] Live annotation feed via Supabase Realtime subscriptions
- [x] Presence indicator ("2 people viewing this page")
- [x] Live cursors (useful for simultaneous video-call review sessions)

---

## v0.4.0 — Notifications ✓

- [x] Webhook support (`data-webhook-url` — fires on new annotation or reply)
- [x] Works with Teams, Slack, Discord, Zapier, Make, n8n, or any URL

---

## v0.5.0 — Sidebar Power-ups ✓

- [x] Filter by type (pin / drawing / highlight) *(type filter removed in v0.9.3 — only pins remain)*
- [x] Filter by status (open / resolved)
- [x] Filter by author
- [x] Search annotations by comment text
- [x] Sort by newest / oldest / unresolved first

---

## v0.6.0 — Page-change Awareness ✓

- [x] Store a lightweight DOM fingerprint with each annotation
- [x] Flag annotations as "may be outdated" when the page structure changes
- [x] Show ⚠ Outdated badge in the sidebar card header

---

## v0.6.1–0.6.3 — Shortcuts & Polish ✓

- [x] T = toggle toolbar panel
- [x] A = toggle annotations sidebar
- [x] Shift+Enter submits comments and replies
- [x] Filters and annotation cards start collapsed
- [x] ANNOTATIONS heading explicitly sans-serif
- [x] Toolbar panel closes automatically when sidebar opens

---

## v0.7.0 — Admin Mode ✓

- [x] Admin section in the toolbar panel (email input + Send magic link button)
- [x] Supabase Auth magic link sign-in — no password, no URL params, no client-side secrets
- [x] `onAuthStateChange` listener shows/hides admin UI and re-renders sidebar on sign-in/out
- [x] Signed-in admin sees Delete button on every annotation regardless of ownership
- [x] Signed-out state shows sign-in form; signed-in state shows email + Sign out button
- [x] Existing installs work identically — no script tag changes required

**Setup:** In your Supabase project, go to Authentication → Users → Invite User. Add your email. Configure Authentication → URL Configuration with your site URL and redirect URLs. Click the magic link in your email to activate admin mode on that browser.

---

## v0.7.1 — Auth Fix ✓

- [x] Switch Supabase Auth to implicit flow (`flowType: 'implicit'`) so magic links work when opened in a different browser or email client (PKCE code verifier was not available cross-browser)

---

## v0.8.0 — Identity & Roles ✓

- [x] Replace name prompt with email prompt on first load
- [x] `signInWithOtp` on first visit — magic link sent automatically, no password ever
- [x] Once signed in, user's display name pulled from `pindrop_profiles` (email prefix on first sign-in)
- [x] Annotations store `user_id` (Supabase Auth UID) alongside `author_token` for backward compatibility
- [x] `pindrop_profiles` table — `id` (auth UID), `display_name`, `is_admin boolean default false`
- [x] Admin flag toggled per-user in Supabase dashboard (replaces magic link admin flow)
- [x] Identity persists across devices and browsers — no more lost ownership on cache clear
- [x] Existing anonymous annotations (author_token only) remain visible and editable by original browser

---

## v0.8.1 — Documentation & SQL Cleanup ✓

- [x] Remove migration blocks from `supabase-setup.sql` — clean single-run schema (no prior installs exist)
- [x] Fold `pindrop_profiles` RLS into the main setup block
- [x] README: remove upgrade notes, update setup section to reference versioned CDN tag
- [x] README: rewrite Admin Mode section as Identity & Admin reflecting v0.8.0 changes
- [x] Bump version to v0.8.1

---

## v0.8.2 — Auth Redirect Fix ✓

- [x] Fix double-hash (`##`) in magic link redirect URL — `emailRedirectTo` now uses `window.location.origin + window.location.pathname` instead of `window.location.href` so no stale fragment is included

---

## v0.8.3 — Send Button Polish ✓

- [x] Disable "Send magic link" button immediately on click to prevent double-submission
- [x] Button only re-enables on error; stays disabled on success (toolbar resets after 4 s if still signed out)

---

## v0.9.0 — Resilient Realtime ✓

- [x] Detect network drop via `window` `online` event and `visibilitychange`
- [x] Re-subscribe to Supabase Realtime channels automatically on reconnect
- [x] Show a subtle amber "⟳ Reconnecting…" badge when the connection is lost
- [x] Dismiss the badge and refresh annotation list once back online
- [x] `teardownRealtime()` clears stale cursors and viewer count on drop
- [x] Reconnect handlers registered once at boot — not duplicated on each re-subscribe

---

## v0.9.1 — Cursor Polish ✓

- [x] Cursor label shows the active tool as an emoji prefix (📍 pin · ✏️ draw · 🖍️ highlight) *(draw/highlight prefixes removed in v0.9.3)*
- [x] Label falls back to just the name when no tool is active
- [x] Tool broadcasted alongside name, color, and position in the cursor payload

---

## v0.9.2 — Resolve Ownership ✓

- [x] Resolve button only shown to the annotation owner (matching `author_token` or `user_id`) or an admin
- [x] Consistent with the existing delete ownership check

---

## v0.9.3 — Pin-Only Focus & Anchoring Reliability ✓

Freehand drawing and text highlights were never built to survive a resize — they stored raw
document-pixel coordinates at creation time and were never re-derived afterward, so any layout
change (a window resize, and *especially* opening on a different device) left them visually
detached from the content they were meant to mark. Pins were the only annotation type with any
anchoring mechanism (a CSS selector + percentage offset, recomputed on load/resize), so rather than
build that same mechanism twice more for drawing and highlighting, this release drops both and
puts the effort into making pin anchoring actually reliable — including on mobile, which is the
case most likely to trigger it (responsive sites commonly swap or hide DOM between breakpoints).

- [x] Remove freehand drawing (canvas overlay, SVG-persisted strokes, Ctrl+Z undo)
- [x] Remove text highlighting (selection capture, highlight rects, sidebar snippet)
- [x] Remove the now-meaningless sidebar type filter and drawing/highlight badges
- [x] Fix: `resolveAnchor` no longer snaps a pin to the scroll origin when its anchored element is
      hidden or collapsed to zero size at the current viewport (e.g. a responsive block that's
      `display:none` at this breakpoint) — it keeps the last known position and marks the pin
      `pd-pin-approx` (dashed outline) with an "Approx." badge in the sidebar instead of asserting
      a wrong one
- [x] Repositioning no longer waits solely on the `resize` event — a debounced `ResizeObserver` on
      the document plus an `orientationchange` listener catch reflow that isn't a literal window
      resize (a lazy image finishing load, a font swap, an accordion opening)
- [x] Pin tool button now toggles on/off (previously one of three tool buttons; now the only one)
- [ ] **Known remaining limitation, not fixed here**: the percentage-in-box offset assumes the
      anchored element scales roughly proportionally. A large viewport jump (desktop → phone) that
      changes an element's aspect ratio a lot — e.g. a paragraph that wraps from 3 lines to 10 —
      can still land the pin somewhere plausible-looking but not exactly where it was dropped, even
      though the element itself resolved fine (`resolved: true`, no approx flag). Anchoring to a
      smaller unit than "whichever element was clicked" (e.g. the nearest text node) would narrow
      this further; scoped as a future improvement, not attempted in this pass.

---

## v0.9.4 — Selector-Escaping Fix ✓

Testing v0.9.3 against a real page turned up a bigger bug than the one it fixed: `getSelectorPath`
built its CSS selector out of raw class names, and Tailwind routinely puts characters into class
names that are meaningful in CSS selector syntax — `:` for variants (`lg:flex-1`), `[...]` for
arbitrary values (`leading-[1.02]`). Used unescaped in a selector string, `document.querySelector`
throws a `SyntaxError` on them. `resolveAnchor` was already catching that and falling back to the
pin's raw creation-time pixel coordinates — so any pin anchored on or under an element carrying one
of these classes never resolved its anchor at all, on any viewport, from the moment it was created.
It only ever looked right by coincidence, at the exact screen size it was dropped at. On a page
built entirely in Tailwind (this one), that's most pins, not an edge case — which is what v0.9.3's
zero-rect guard couldn't have caught, since the selector was throwing, not resolving to a
collapsed/hidden element.

- [x] Fix: `getSelectorPath` now runs every class name and id segment through `CSS.escape()` before
      building the selector string, so Tailwind variant/arbitrary-value classes (`lg:flex-1`,
      `leading-[1.02]`, `w-1/2`, etc.) no longer break selector matching
- [x] Verified against a real pin anchored inside this site's hero `<h1>` (a `leading-[1.02]` /
      `lg:flex-1` ancestor chain) — selector now resolves correctly instead of throwing
- [ ] **Not fixed by this release**: annotations already stored with a pre-v0.9.4 selector still
      carry the broken, unescaped string — this fix only prevents *new* selectors from being
      malformed. Existing pins on real class names with `:` or `[...]` need to be deleted and
      re-dropped after upgrading; there's no in-place migration for a stored selector string.

---

## v1.0.0 — Production Ready

- [ ] Export annotations as CSV (download all open/resolved annotations with author, page, comment, timestamp)
- [ ] Graceful reconnect indicator dismissed cleanly when session is restored
- [ ] Admin dashboard — standalone page listing all annotations across all pages
- [ ] Email digest via Supabase Edge Function (daily or on-demand summary to admin)
- [ ] README covers full setup end-to-end including Supabase Auth URL config and admin flag

---

## Future Ideas

- Email digest via Supabase Edge Function
- Cursor label shows active tool/color
- Smooth cursor interpolation
- Reconnect gracefully on network drop
- Attachments / screenshots on comments
- Export annotations as PDF or CSV
- Annotation "sessions" (group a review into a named round)
- Admin dashboard (separate page to review all annotations across all pages)
