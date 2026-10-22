# Extension icons

`icon.svg`, `blocked.svg` and `paused.svg` are the sources for every PNG in
`v3/data/icons/`:

| Source | When it shows | Output |
|---|---|---|
| `icon.svg` | default toolbar and store icon | `16 32 48 64 128 256.png` |
| `blocked.svg` | toolbar on a locked page, lock-screen tab | `blocked/16 32 256.png` |
| `paused.svg` | while blocking is paused (open lock) | `paused/16 32 256.png` |

To regenerate them after editing an SVG, run `render.mjs` with bun. It needs
`playwright-core` and a Chromium binary:

```sh
CHROMIUM=/path/to/chromium bun assets/icons/render.mjs
```

At 16px the keyhole is dropped and the shackle is drawn thicker, so the lock
stays readable in the toolbar.
