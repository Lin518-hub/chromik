# Contributing to Chromik 珂影

Thank you for helping improve Chromik. Keep changes focused, reversible and
covered by tests when they affect colour, geometry, storage or export.

## Development

Chromik requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Before opening a pull request, run:

```bash
npm run verify
npm run test:coverage
```

Colour-pipeline changes must keep preview, histogram, waveform, thumbnail and
export on the same 16-bit linear source and shared Float32 processing graph.
Update the visual golden only when the intended appearance change is described
in the pull request.

Do not commit camera originals, personal catalogues, private LUTs, signing
credentials or generated release packages. Test photographs require an
explicit redistributable licence.

By submitting a contribution, you agree that it is licensed under Apache-2.0.
