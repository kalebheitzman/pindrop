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

## v0.2.0 — Edit & Undo

- [ ] Edit a comment or reply after posting
- [ ] Drawing undo (Ctrl+Z removes last stroke)
- [ ] Keyboard shortcuts (P = pin, D = draw, H = highlight, Esc = cancel)

---

## v0.3.0 — Real-time Collaboration

- [ ] Live annotation feed via Supabase Realtime subscriptions
- [ ] See other users' cursors / annotations appear without refreshing
- [ ] Presence indicator ("2 people viewing this page")

---

## v0.4.0 — Notifications

- [ ] Webhook support (ping a URL on new annotation or reply)
- [ ] Slack integration (post to a channel when feedback is left)
- [ ] Email digest via Supabase Edge Function

---

## v0.5.0 — Sidebar Power-ups

- [ ] Filter by type (pin / drawing / highlight)
- [ ] Filter by status (open / resolved)
- [ ] Filter by author
- [ ] Search annotations by comment text
- [ ] Sort by newest / oldest / unresolved first

---

## v0.6.0 — Page-change Awareness

- [ ] Store a lightweight DOM fingerprint with each annotation
- [ ] Flag annotations as "may be outdated" when the page structure changes
- [ ] Show diff indicator in the sidebar card

---

## Future Ideas

- Attachments / screenshots on comments
- Optional Supabase Auth for persistent identity across devices
- Export annotations as PDF or CSV
- Annotation "sessions" (group a review into a named round)
- Admin dashboard (separate page to review all annotations across all pages)
