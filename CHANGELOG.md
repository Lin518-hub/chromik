# Changelog

All notable changes to Chromik 珂影 are documented here.

## Unreleased

### Changed

- Unified RAW analysis, preview, histogram, waveform, thumbnail and export on a
  versioned 16-bit linear proxy and one Float32 processing graph.
- Reworked colour-negative film-base and density-anchor estimation around
  co-located RGB samples, robust chromatic populations and bounded crossover
  correction.
- Added the default soft negative rendering intent with a smooth toe and
  shoulder while keeping exposure at zero.
- Loading a 100% view now requests a full-resolution proof instead of scaling
  the interactive proxy.
- Clarified the film-region selection workflow and automatic exclusion of
  light-table and sprocket-hole pixels.

### Fixed

- Preview banding and proxy/full-resolution ambiguity.
- Rotation, flip, crop-coordinate and lens-correction geometry edge cases.
- Uncalibrated legacy frames not inheriting their first roll calibration.
- Cancelled RAW/contact/export tasks leaving partial files.
- Smoke tests reporting success without reaching all six target views.

### Security and release

- Added isolated QA user-data roots, atomic cache writes, recovery bookkeeping,
  Apache-2.0 licensing, contributor guidance and a security policy.
