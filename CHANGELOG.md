# Changelog

## 0.5.5

- Fixed zero-padded TTD ticket dropdowns such as `01` / `02`. Ticket counts are now compared numerically, so an already-selected `01` is treated as ticket count 1 and FastFill no longer opens the dropdown looking for a non-existent `1` option.
- Numeric ticket dropdown matching now preserves TTD's display format and can match `1` to `01`, `2` to `02`, etc.
- Disabled ticket inputs such as a fixed `01` are treated as fixed TTD counts instead of being clicked as dropdowns.
- Added Arjitha Seva card fallback for pages that do not render explicit `Slot Time` controls. FastFill first looks for normal timed slots; when none exist, it detects the visible Seva cards and chooses the first card with an availability count greater than 1.
- Seva-card fallback ignores cards with 0 or 1 available and can move to the next qualifying card after a recognized TTD rejection.
- Selected-date recognition now also supports headings such as `Select any 1 Seva: Dated 28 Oct,2026`.
- Live Inspector now reports visible Seva-card counts and how many have more than 1 available.
- Added `seva-card.html` local mock covering the captured `Kalyanotsavam` style card flow.

## 0.5.4

- Added Arjitha Seva slot-page awareness for the live `Temple` (`templeSelected`) and `Select Seva` (`sevaSelected`) controls. FastFill snapshots the existing TTD selection and never switches these dropdowns automatically.
- Added a safety check that stops the run if Temple/Seva changes after Start, preventing a saved date plan from being applied to a different service calendar.
- Added date-only seva support: when a selected date has no time-slot controls, FastFill proceeds using the visible/fixed ticket count when available, fills optional laddus/hundi when present, and continues.
- Timed sevas keep the existing preferred-time / any-available-time behavior.
- Ticket-count detection now supports blank readonly ticket dropdowns, fixed displayed counts such as `01`, and pages where TTD determines the count later. A fixed count above the configured maximum is rejected.
- Calendar day lookup now disambiguates duplicate `day/monthIndex` IDs by the enclosing month/year heading.
- Selected-date recognition now understands TTD's primary-purple selected day in addition to the older `Select any 1 Slot` text.
- Full/not-released days with `pointer-events:none` and unavailable days with `cursor:not-allowed` are skipped instead of being clicked.
- Added conditional Additional Laddus and Hundi filling to both timed and date-only seva flows.
- Live Inspector now shows current Temple, Seva, visible time-slot count, and ticket selector/fixed-count status.
- Added `seva-date-only.html` and `seva-review.html` mocks for the new no-time-slot end-to-end flow.
- Retains v0.5 DOM-first pilgrim recognition, General Details autofill, reduced-capacity pilgrim priority, failure recovery, no-reload attachment, and optional Gemini fallback.

## 0.5.0

- Fixed page recognition for TTD seva pilgrim forms that use `name`, `age`, `gender`, `idType`, and `idNumber` instead of the older `fname`, `photoIdType`, and `idProofNumber` field names.
- Page recognition is now DOM-first. Visible pilgrim/review structures win over stale Next.js URLs or `__NEXT_DATA__` routes such as `/curtain` or `/spat/slot-booking`.
- Added a second built-in pilgrim schema for seva flows while retaining the existing darshan schema.
- Added booking-level General Details autofill for `gothram`, `pilgrimEmail`, `pilgrimCity`, `pilgrimState`, `pilgrimCountry`, and `pilgrimPincode`.
- Added Email, City, State, Country, and Pincode fields to the extension setup. These are used only when the current TTD form asks for them.
- Gothram text inputs are filled exactly as saved. Dropdown fuzzy matching remains available if a future/current flow uses a dropdown.
- Added explicit waits for TTD to enable Photo ID Proof and Photo ID Number fields before filling them.
- Live Inspector now reports which pilgrim schema was detected and classifies the new General Details fields.
- Review detection now also supports TTD seva review containers/final Confirm-style actions, not only a literal `Pay Now` button.
- Added `seva-pilgrims.html` mock page that mirrors the newly captured TTD field names and one-ticket/two-pilgrim style flow.
- Retains v0.4.1 no-reload attach, countdown watching, multi-date/time search, failure recovery, reduced-capacity fallback, priority pilgrim filling, adaptive fields, and optional Gemini fallback.

## 0.4.1

- Content script now starts at `document_start` on supported TTD pages.
- Added no-reload attachment using `chrome.scripting.executeScript` for TTD tabs that were already open.
- Added connection status plus **Attach without reload** and **Re-detect** controls.
- `Start on this page` and `Live inspector` automatically attach when needed instead of asking for a TTD reload.
- Added `TTDFF_PING`, re-detect, and shutdown/reinjection support for safer same-version attachment.
- Added live countdown detection/reporting for queue/waiting pages.
- Inspector now updates continuously while open and reports countdown, version, watcher status, URL, and last DOM/route changes.
- Unknown pages are now a waiting state, not a fatal state; FastFill remains attached and watches for the booking calendar.
- Added a lightweight local URL/sanity watcher alongside the MutationObserver for Next.js transitions.
- Added a local `queue.html` mock for countdown and no-reload attachment testing.
- Retains all v0.4 multi-date/time, failure recovery, reduced ticket capacity, pilgrim priority, Gothram fuzzy matching, adaptive fields, and Gemini fallback behavior.

## 0.4.0

- Added ordered multiple-date selection.
- Added ordered multiple-time selection.
- FastFill now searches date × time combinations in priority order.
- Added one-attempt-per-combination failure tracking.
- Added recognized TTD failure popup detection and recovery.
- FastFill closes recognized failure dialogs and uses TTD Back when necessary to return to slot selection.
- Added configurable maximum booking attempts to prevent accidental retry loops.
- Requested ticket count is now a maximum: if TTD only offers fewer tickets, FastFill selects the highest allowed count at or below the request.
- Pilgrim rows remain authoritative. If fewer rows are rendered than profiles prepared, FastFill fills only the first N profiles in saved priority order.
- Added Gothram fuzzy matching against TTD's real dropdown values. Close spellings such as `kasyapa` / `kasyappa` can resolve to `Kashyapa` when the match is unambiguous.
- Added Gothram alias learning after a successful dropdown match.
- Added common Gothram suggestions in the extension UI. These are suggestions only; TTD's live dropdown remains authoritative.
- Added a live attempt log in the popup.
- Updated the local mock TTD flow to test: first-slot failure recovery, requested 4 tickets falling back to 2, first-two-pilgrims priority behavior, and Gothram spelling resolution.
- Retains all v0.3 adaptive-field, inspector, Gemini fallback, and local-learning behavior.

## 0.3.0

- Added adaptive-field discovery, Gothram handling, field inspector, learned mappings, user prompts, and optional sanitized Gemini classification fallback.
