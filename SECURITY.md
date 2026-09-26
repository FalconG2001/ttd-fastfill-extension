# Security and privacy

TTD FastFill is designed to work only on the official TTD host, plus localhost in the explicit test manifest.

## The extension does not handle

- TTD passwords
- OTPs
- CAPTCHA solving
- virtual-queue bypassing
- payment-card / UPI credentials
- payment OTPs

## Sensitive pilgrim details

Persistent storage of pilgrim ID details is optional. Leave **Remember pilgrim ID details** off to keep those profiles in Chrome session storage.

## Gemini

Gemini support is optional and disabled by default. The extension sends only sanitized field metadata for field classification. Personal answers, pilgrim names, ID numbers, payment data, cookies, tokens, and TTD session credentials are not intentionally sent to Gemini.

The Gemini API key itself is stored in Chrome local extension storage when configured. For a public/distributed product, a user-supplied raw API key is not ideal. A production service should use a safer backend/key-management design.

## Failure recovery

Automatic recovery only acts on visible dialogs whose text matches conservative failure/error patterns. Unknown dialogs are not blindly accepted. A maximum-attempt limit prevents endless retry loops.

## No-reload attachment

v0.4.1 uses Chrome's `scripting` permission only to inject FastFill's own packaged `src/content.js` into an already-open supported TTD (or local test) tab when no active FastFill listener is present. It does not fetch or execute remote code. This is specifically to avoid requiring a user to refresh a TTD queue/countdown page.


## General Details in v0.5

Gothram, email, city, state, country, and pincode can be saved in the extension configuration so they are ready before a high-demand booking opens. They stay in Chrome extension storage and are only inserted into TTD pages when matching fields are present. Gemini receives only sanitized field metadata, not these saved values.
