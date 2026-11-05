# Self-hosted webfonts

These are served from our own origin on purpose. `site/index.html` already notes
that the videos are self-hosted rather than embedded from Instagram, because an
embed loads Meta's scripts and cookies and the privacy policy says we don't use
those. A webfont CDN (Google Fonts, Adobe, Bunny) is the same problem wearing a
different hat: every page view becomes a request to a third party carrying the
visitor's IP and referrer. So the files live here.

Both faces are SIL Open Font License 1.1, which permits redistribution as long
as the licence travels with the font — hence the two LICENSE files. They must be
copied to the server alongside the pages.

| File | Face | Version | Source |
|---|---|---|---|
| `AtkinsonHyperlegibleNext-latin.woff2` | Atkinson Hyperlegible Next | v7 (Google Fonts build) | fonts.gstatic.com |
| `AtkinsonHyperlegibleNext-latin-ext.woff2` | ditto, Latin Extended subset | v7 | fonts.gstatic.com |
| `DepartureMono-Regular.woff2` | Departure Mono | 1.500 | github.com/rektdeckard/departure-mono release |

Atkinson Hyperlegible Next is a **variable** font: the one file covers 400
through 700, so there is no separate bold file to add. Commissioned by the
Braille Institute; the letterforms are drawn for distinction between commonly
confused characters, which is why it carries the body copy everywhere.

Departure Mono is by Helena Zhang (departuremono.com). It is a pixel face: it is
for headings, labels and anything representing the 128x32 device screen, never
for paragraphs.
