# Aus Emergency Dispatcher Design

This interface follows the visual language established by the `hub` repository. The product should feel like a quiet operational desktop tool: dark, compact, readable, and deliberate.

## Source Of Truth

The reference implementation is `C:\Users\levis\Documents\Development files\hub`, especially:

- `renderer/components/index.css`
- `renderer/tailwind.config.js`
- `renderer/components/Layout.tsx`
- `renderer/pages/index.tsx`

Use existing project patterns before introducing new visual primitives.

## Typography

- Primary UI text: `Manrope`, with `Segoe UI` and `sans-serif` fallbacks.
- Headings and controls: `Inter`, with `Segoe UI` and `sans-serif` fallbacks.
- IDs, timestamps, telemetry, and technical values: `JetBrains Mono`, with `Consolas` and `monospace` fallbacks.
- Do not depend on a remote font download. The fallback stack must remain usable offline.
- Use compact, medium-to-semibold weights. Reserve bold weights for labels, status, and primary actions.
- Keep letter spacing neutral except for small uppercase eyebrow labels.

## Colour

The base surface is the hub's dark operational palette:

| Token | Value | Use |
| --- | --- | --- |
| `navy-dark` | `#0E131B` | App and page background |
| `navy` | `#171E2C` | Primary panels |
| `navy-light` | `#1F2A3C` | Raised panels and controls |
| `navy-lightest` | `#273347` | Borders and hover states |
| `quasi-white` | `#FAFAFA` | Primary text |
| `cyan` | `#00E0FE` | Technical accent and focus |
| `dodger-light` | `#00BBFF` | Secondary blue accent |
| `red` | `#FC3A3A` | Emergency state and alerts |

Use zinc and slate utilities where they already match the hub. Avoid purple gradients, pale marketing surfaces, and excessive colour decoration.

## Layout

- Prefer full-screen or full-width operational surfaces over nested cards.
- Keep content aligned to a clear max-width and use consistent spacing.
- Use small radii, generally `4px` for controls and `8px` or less for framed items.
- The hub's simple landing pattern is a centered content block on a dark background with restrained supporting text.
- Navigation and tool surfaces should remain dense enough for repeated use without feeling crowded.

## Splash And Landing

- `/` is the startup splash. It keeps the alternating Australian emergency red/blue beacon treatment (a rapid double-flash strobe, synced side-wash, and a single light sweep) and supports the saved AED/RAAFv profile. A HUD corner frame, mono eyebrow/version, and a slim indeterminate loader carry the rest of the hierarchy.
- `/home` is the intentionally calm standby landing page until the dispatcher console is ready: the profile lockup, a "Console coming soon" card, and a live system-status strip (CAD / Mapping / Radio from `getSystemStatus`). Its ambient is a static beacon-tinted gradient, not motion.
- Splash motion should be short, legible, and purposeful. Do not add page-load or entrance animation to the standby screen; the only motion there is the standby status indicator.
- Honour `prefers-reduced-motion`: the splash falls back to steady dual beacons and a static loader.
- Profile-specific branding belongs in the shared splash profile configuration, not duplicated in page markup.

## Components And Interaction

- Use familiar iconography for controls and text for clear commands.
- Keep hover and focus states visible against dark surfaces.
- Preserve offline operation for the shell and splash. Network-dependent features must fail quietly and expose a useful status.
- Do not add remote assets or font requirements without a local fallback.