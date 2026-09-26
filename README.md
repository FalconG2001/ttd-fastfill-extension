# TTD FastFill v0.5.5

Chrome / Chromium Manifest V3 extension for quickly completing TTD booking forms **after TTD itself allows the user through its official queue**.

## What v0.5.5 adds

v0.5.5 keeps the Arjitha Seva service-context behavior from v0.5.4 and adds two live-site fixes. Ticket selectors that display zero-padded values such as `01` / `02` are now handled numerically without losing TTD's display value. Also, after a date is selected FastFill first checks for explicit `Slot Time` cards; if none exist, it can detect the alternate Seva-card layout and select the first card whose displayed availability is greater than 1.

A selected seva can now use either of these flows:

- **Timed seva:** date → preferred time / any available time → ticket count → optional laddus/hundi → Continue.
- **Date-only seva:** date → ticket count if TTD exposes one (or TTD's fixed count) → optional laddus/hundi → Continue. Preferred times are ignored when no time-slot controls exist.

The calendar lookup also handles TTD's duplicate day IDs across adjacent month tables by checking the month/year heading before clicking a day. Full, unreleased, and unavailable days are skipped based on their actual interaction state.

Live Inspector now reports the selected Temple, selected Seva, visible time-slot count, and whether a ticket selector/fixed ticket count is visible.

## What v0.5 fixes

TTD does not use one pilgrim form shape everywhere. The newer seva page captured for Sri Srinivasa Divyaanugraha Homam uses:

- booking-level fields: `gothram`, `pilgrimEmail`, `pilgrimCity`, `pilgrimState`, `pilgrimCountry`, `pilgrimPincode`
- pilgrim rows: `name`, `age`, `gender`, `idType`, `idNumber`

Older darshan pages use names such as `fname`, `photoIdType`, and `idProofNumber`. v0.5 recognizes both schemas. It also recognizes the visible DOM before trusting the URL because TTD's Next.js page can show pilgrim details while the route still looks like `/curtain` or `/spat/slot-booking`.

The popup now includes **General details** for Gothram, email, city, state, country, and pincode. These values are only filled when the current TTD form actually contains those fields. If Gothram is a normal text field, FastFill uses the saved spelling exactly.

FastFill does not bypass the queue, login, CAPTCHA, OTP, or payment authentication. It operates on the normal TTD pages in the user's existing browser session and stops at the payment gateway.

## What v0.4.1 added

### No-reload attachment and recovery

FastFill now loads at `document_start` on TTD pages. If the TTD tab was already open before FastFill was installed/reloaded, the popup can inject the current content script into that existing tab with **Attach without reload**. This preserves the TTD page/queue state.

`Start on this page`, `Live inspector`, and `Re-detect` also attempt no-reload attachment automatically. An unrecognized page is treated as **UNKNOWN / still watching**, not as a fatal error.

Important when upgrading while already in a TTD queue: disable/remove the older FastFill extension, load v0.5.5, then use **Attach without reload** on the existing TTD tab. Do not refresh the TTD tab.

### Live countdown inspector

The inspector now stays live while the popup remains open. When a TTD queue/countdown is detectable, it shows the current countdown and updates it approximately twice per second. It also reports:

- FastFill connection/version,
- detected page state,
- current URL,
- DOM watcher state,
- URL/sanity watcher state,
- last DOM/route change,
- detected pilgrim fields when present.

FastFill only observes the official queue/countdown. It does not bypass it or refresh the page.

### Reliability watchers

In addition to DOM observation, v0.4.1 watches URL changes and performs a lightweight local sanity check while a run is active. This helps detect Next.js transitions even when there is no full navigation.

## What v0.4 adds

### Multiple dates and times

Dates and times are ordered priorities. Example:

- Dates: Sep 17, Sep 18, Sep 19
- Times: 3:00 PM, 4:00 PM, 5:00 PM

FastFill tries them in this order:

1. Sep 17 / 3:00 PM
2. Sep 17 / 4:00 PM
3. Sep 17 / 5:00 PM
4. Sep 18 / 3:00 PM
5. ...

If **Any available time** is enabled, other available times on a date are considered after the preferred times.

### Failure recovery

When a selected slot looked available but TTD returns a recognized failure popup, FastFill:

1. marks that exact date/time combination failed,
2. closes the popup,
3. returns to the slot page using TTD's own **Back** button when required,
4. tries the next configured combination.

The same combination is not submitted repeatedly. A configurable maximum-attempt limit is also enforced.

Because TTD has several dialog implementations and can change them, failure detection is intentionally conservative. If a new popup is not recognized, FastFill stops instead of blindly clicking through it. Use **Inspect page** and capture the rendered popup HTML so the detector can be hardened.

### Requested 4, but TTD only allows 2

The **Requested tickets** value is treated as a maximum.

Example:

- Requested tickets: 4
- TTD ticket dropdown currently offers only: 1, 2
- FastFill selects: 2

After Continue, TTD's actual pilgrim row count is authoritative. If TTD renders 2 pilgrim rows while 4 profiles were prepared, FastFill fills:

- Pilgrim 1
- Pilgrim 2

and ignores Pilgrims 3 and 4 for that booking attempt. Profile order is therefore priority order.

FastFill never invents a missing pilgrim. If TTD renders more rows than the number of prepared profiles, it stops.

### Gothram matching

For a normal text field, FastFill enters the saved value as typed.

For a TTD dropdown, it reads the live options and resolves the saved text using:

1. exact normalized match,
2. a unique prefix match (minimum 3 characters),
3. conservative fuzzy string similarity.

Examples that can resolve to a TTD option `Kashyapa` when unambiguous:

- `kasyapa`
- `kasyappa`
- `kas`

If more than one TTD option is plausible, FastFill asks the user instead of guessing. Confirmed aliases are learned locally.

The built-in Gothram list in the popup is only a convenience suggestion list. The live TTD dropdown spelling is authoritative.

## Install production build

1. Unzip the production build ZIP.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted build folder.
6. Verify the extension version is `0.5.5`.
7. If a TTD page is already open, **do not reload it**. Open FastFill and click **Attach without reload** (or Start/Live inspector, which auto-attach).

## Recommended first live test

Turn **Auto Pay Now** off.

Use a low-demand darshan first and configure two dates / two times. Confirm:

- date priority,
- time priority,
- requested ticket fallback,
- pilgrim row count behavior,
- review date/time/ticket values.

Only enable automatic Pay Now after the review page has been validated manually at least once.

## Local v0.5.5 mock tests

For the alternate **Seva card** flow captured from the live site, open:

```text
http://localhost:4173/seva-card.html
```

Suggested setup: preferred date `2026-10-28`, requested tickets `1`, Auto Pay Now OFF. Expected behavior: FastFill sees no explicit `Slot Time` cards, ignores the card showing `0 Available`, selects the first card with more than 1 available, accepts the fixed/disabled `01` ticket count, and continues.


The repo contains fake TTD pages for both the older darshan schema and the newer seva schema.

From the repo root:

```bash
python3 scripts/manifest_mode.py test
python3 -m http.server 4173 --directory test/mock-ttd
```

Then reload the extension at `chrome://extensions`.

For the queue/countdown + no-reload inspector test, open:

```text
http://localhost:4173/queue.html
```

Click **Live inspector**. The countdown should update. You can reload/disable-enable the extension itself and then click **Attach without reload**; the queue page should not need to be refreshed.



For the new **Arjitha Seva date-only** flow, open:

```text
http://localhost:4173/seva-date-only.html
```

Suggested setup:

- Preferred date: `2026-10-20`
- Requested tickets: `4` (the mock seva has a fixed 1 ticket)
- Additional laddus: any non-zero test value, for example `2`
- Hundi: any non-zero test value, for example `100`
- Auto Pay Now: OFF for the first run

Expected behavior: FastFill keeps the existing Temple/Seva, selects Oct 20, detects that there is no time-slot panel, accepts TTD's fixed ticket count, fills the optional service values, continues to the seva pilgrim form, fills General Details and the actual pilgrim rows, then stops on the seva review page. Turn Auto Pay Now on only after that review has been checked.

For the new seva pilgrim-form recognition test, open:

```text
http://localhost:4173/seva-pilgrims.html
```

Before opening it, save a setup with at least two pilgrim profiles plus the General Details you want to test. The mock renders booking-level Gothram/email/city/state/country/pincode and the newer `name` / `idType` / `idNumber` pilgrim schema. Live Inspector should report `Page state: PILGRIMS` and `pilgrim schema=seva`.

For the booking-flow test, open:

```text
http://localhost:4173/slot.html
```

Suggested setup:

- Dates: 2026-09-17, 2026-09-18
- Times: 15:00, 16:00
- Requested tickets: 4
- Pilgrim profiles: 4
- Persons per ticket: Auto
- Auto recovery: ON
- Auto Pay Now: OFF
- Gothram for the first two pilgrims: `kasyapa` or `kasyappa`

The mock is intentionally configured so that:

- Sep 17 / 3:00 PM fails once with a popup,
- FastFill should close the popup and move to Sep 17 / 4:00 PM,
- the ticket dropdown offers only 1 or 2, so requested 4 becomes 2,
- the pilgrim page renders only 2 rows,
- FastFill fills only Pilgrim 1 and Pilgrim 2,
- the Gothram dropdown contains `Kashyapa`, so a close spelling should resolve automatically,
- the extension should stop on the review page because Auto Pay Now is off.

After local testing, restore production mode:

```bash
python3 scripts/manifest_mode.py prod
```

Then reload the extension again.

## Storage

By default, pilgrim details are kept in Chrome session storage. If **Remember pilgrim ID details** is enabled, they are saved to `chrome.storage.local`.

Learned form mappings, adaptive answers, and Gothram aliases are stored locally. They can be cleared with **Clear learned fields**.

## Gemini fallback

Gemini is optional and disabled by default. It is only used to classify an unknown field after deterministic and learned matching fail.

Gemini receives sanitized metadata such as label, name/id pattern, control type, scope, and option text. It should never receive pilgrim names or Photo ID numbers, and it never invents personal values.

## Important limitation

v0.5.5 can only select dates currently rendered in TTD's calendar DOM. It does not yet page through calendar months automatically.
# ttd-fastfill-extension
