# Design language — the SynthWatch dashboard

> _Prose — describes intent and conventions; the components under `src/components/**` and the tokens in
> `src/app/globals.css` are authoritative._

A **"control room" instrument-panel** aesthetic: deep instrument-dark surfaces, a faint technical grid, a
phosphor-teal brand accent, and IBM Plex Sans / IBM Plex Mono. Dense but legible, one screenful on mobile,
dark-native.

## The absolute laws

- **Status-color law.** `pass = green · warn = amber · fail/error = red`, everywhere, no exceptions. Status is
  never conveyed by colour *alone* — every status also carries a shape/glyph + a text label (≈8% of men are
  red-green colourblind; a colour-only signal is a bug).
- **Honest render — three states, never two.** Every panel distinguishes *present* / *honestly-absent* (hide) /
  *broken* (a loud error). Absent must never render as a healthy `0` / empty / green. A null is `—`, not `0`.
- **No browser storage for view state.** All state is server state + URL params (`?status=`, `?tab=`, `?tags=`).
  The only thing in `localStorage` is the session token.

## Why these choices

- **Dark-native, one-screen-mobile:** the primary reader is an operator at 2am, on a phone, deciding "is this a
  real outage or is the monitor lying?" Density and legibility beat decoration.
- **URL-as-state:** a filtered view is shareable and reload-safe; there is no hidden client state to desync.

For the operator glossary of the jargon these surfaces use (flap, spurious-red, flake budget, divergence), see
the in-app `/glossary` route.
