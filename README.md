# bôngiu🤍

Three photo fixes for iPhone, in the browser. Photos never leave the device.

- **Even out a set**: pick a reference photo, add the rest; every photo is cropped so its subject has the
  reference's size and position. Subjects are found with MediaPipe (faces, then body poses, then objects) and
  can be placed by hand. Saves pixel-exact crops from the originals, in Display P3 where the browser embeds the
  profile, with the date taken kept in JPEGs.
- **Copy the look**: pick a reference photo whose colours you like, add the rest; each photo takes the
  reference's grade (tone curve ends, tint of near-neutral tones in shadows / mid-tones / highlights, strength of
  its strongest colours) measured in Oklab, applied as a 33³ lookup table. Skin keeps most of its hue and
  brightness. One strength slider, 0–150%.
- **Remove people & objects**: tap a thing (MediaPipe Magic Touch) or paint over it, then Remove. The gap is
  filled by MI-GAN running in ONNX Runtime Web. Only the filled areas change; every other pixel stays original.

Live: https://idkltmk-gif.github.io/bongiu/

## Files

| Path | What |
| --- | --- |
| `index.html` | the screen's markup |
| `style.css` | all styles |
| `js/app.js` | the three tools: screens, gestures, Remove, saving |
| `js/look.js` | Copy the look colour grade (pure, tested) |
| `js/frame.js` | Even out a set framing math (pure, tested) |
| `js/exif.js` | date taken read from and written into JPEGs (pure, tested) |
| `sw.js` | offline: models cache first, everything else network first |
| `mp/` | third-party engines and models, served as is (see `THIRD_PARTY_NOTICES.md`) |
| `tests/` | Node tests for `frame.js`, `look.js` and `exif.js` |

## Develop

No build step: GitHub Pages serves the files as they are. Run it locally with any static server, for example:

```bash
python3 -m http.server 8000
```

Tests and formatting (Node 20+):

```bash
npm test
npm run format
```

When a file in `mp/` changes, give it a new name (it is cached forever). When changing the cache name `V` in
`sw.js`, add the old name to `OLD` so cached models are carried over.
