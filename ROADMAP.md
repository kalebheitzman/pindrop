# Pindrop Roadmap

A living document tracking what's done, what's next, and what's planned.

---

## v0.1.x — Foundation ✓

- [x] Pin annotations with comments
- [x] Freehand drawing
- [x] Text highlight annotations
- [x] Threaded replies
- [x] Resolve / collapse annotations
- [x] Delete (anonymous ownership via localStorage token)
- [x] Focus / dim mode
- [x] Element anchoring (pins reposition across screen sizes)
- [x] Name prompt on first load
- [x] Drop-in script tag install (`data-supabase-url`, `data-supabase-key`)
- [x] 10-color palette

---

## v0.2.x — Edit & Undo ✓

- [x] Edit a comment or reply after posting
- [x] Drawing undo (Ctrl+Z removes last stroke)
- [x] Keyboard shortcuts (P = pin, D = draw, H = highlight, Esc = cancel)

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

- [x] Filter by type (pin / drawing / highlight)
- [x] Filter by status (open / resolved)
- [x] Filter by author
- [x] Search annotations by comment text
- [x] Sort by newest / oldest / unresolved first

---

## v0.6.0 — Page-change Awareness

- [ ] Store a lightweight DOM fingerprint with each annotation
- [ ] Flag annotations as "may be outdated" when the page structure changes
- [ ] Show diff indicator in the sidebar card

---

## Future Ideas

- Email digest via Supabase Edge Function
- Cursor label shows active tool/color
- Smooth cursor interpolation
- Reconnect gracefully on network drop
- Attachments / screenshots on comments
- Optional Supabase Auth for persistent identity across devices
- Export annotations as PDF or CSV
- Annotation "sessions" (group a review into a named round)
- Admin dashboard (separate page to review all annotations across all pages)
