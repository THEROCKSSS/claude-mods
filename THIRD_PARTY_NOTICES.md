# Third-party notices

## Vendored into this repository

| Code | Where | License |
| --- | --- | --- |
| [QR Code Generator for JavaScript](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 | `mods/port-watch/hooks/vendor/qrcode.mjs` | MIT, Copyright (c) 2009 Kazuhiko Arase |
| [blast-radius, mission-control](https://github.com/hamzafer/claude-code-mods) and their shared bands helper | `mods/blast-radius-win`, `mods/mission-control-win` | MIT, Copyright (c) 2026 Hamza Zafar (see [LICENSE](LICENSE)) |

"QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

## Bundled into `mods/mod-hub/app`

The hub's built web app bundles these npm packages, all under MIT unless noted:
- react and react-dom
- three, with @react-three/fiber
- radix-ui
- cmdk
- motion
- sonner
- class-variance-authority
- lucide-react (ISC)
- tailwindcss

`mods/mod-hub/web/package-lock.json` lists the exact versions.

### The MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
