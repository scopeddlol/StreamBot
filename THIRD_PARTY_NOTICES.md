# UI sources and notices

The dashboard follows the HTML/EJS guidance in [BladeUI](https://github.com/scopeddlol/BladeUI), reviewed at commit `beeae80e1e2b1b37dd0301872002edf578a1b31d`. StreamBot retains its existing EJS/JavaScript/native-control implementation and shared CSS theme. No additional UI framework or remote asset dependency is introduced.

## Tabler layout direction

The grouped sidebar, page header, metrics row and content composition were informed by Tabler's [vertical dashboard layout](https://github.com/tabler/tabler/blob/4f07e8a2a00f1441b48631bb13cf12953d6d89c3/preview/pages/layout-vertical.astro). No Tabler CSS or JavaScript source is bundled. App-specific composition lives in `src/server/views/pages/tv.ejs`, `src/server/views/layouts/tv-library.ejs` and `src/server/public/tv/`.

## Tabler Icons

Twelve outline SVG icons in `src/server/public/tv/icons/` are from [Tabler Icons v3.35.0](https://github.com/tabler/tabler-icons/tree/v3.35.0/icons/outline): `arrow-up-right`, `broadcast`, `device-tv`, `layout-dashboard`, `logout`, `movie`, `player-play`, `plug-connected`, `plus`, `settings`, `shield-check` and `sparkles`. Sources retain their SVG metadata. Icons are served locally, marked decorative beside text labels and colored using the shared theme.

[Upstream license](https://github.com/tabler/tabler-icons/blob/v3.35.0/LICENSE):

MIT License

Copyright (c) 2020-2025 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
