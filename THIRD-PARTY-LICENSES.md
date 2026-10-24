# Third-Party Notices

This project bundles or depends on third-party components whose licenses
require attribution or carry obligations worth knowing about. Everything else
in the dependency tree is under permissive licenses (MIT, Apache-2.0, ISC,
BSD) that require no action. Full license texts ship inside each package in
`node_modules/`.

## Roboto (webfont) — SIL Open Font License 1.1

The web app bundles the Roboto variable font via
[`@fontsource-variable/roboto`](https://www.npmjs.com/package/@fontsource-variable/roboto)
(`packages/ui/src/styles/globals.css`, `apps/web/src/routes/__root.tsx`). The
`.woff2` files are emitted into the client build.

> Copyright 2011 The Roboto Project Authors
> (https://github.com/googlefonts/roboto-classic)
>
> This Font Software is licensed under the SIL Open Font License, Version 1.1.
> The full license text is available at http://scripts.sil.org/OFL and ships
> with the package at `node_modules/@fontsource-variable/roboto/LICENSE`.

The OFL permits bundling the font in commercial products. Its two obligations:
the font files may not be sold on their own, and this notice must accompany
redistributions of the font. Keep this file (or an equivalent notice) if you
ship the bundled font; it does not apply if you swap Roboto for another font
during rebranding.

## libvips (via `sharp`) — LGPL-3.0-or-later

Server-side image transforms use [`sharp`](https://sharp.pixelplumbing.com)
(Apache-2.0), which loads prebuilt [libvips](https://www.libvips.org) binaries
from `@img/sharp-libvips-*` packages. libvips is LGPL-3.0-or-later.

This imposes no obligations on your application code: libvips is dynamically
linked at runtime as a separate, replaceable npm package and is never compiled
into your code or shipped to browsers. The LGPL's requirements (source
availability for libvips itself, replaceability) are satisfied by the npm
packaging model. The whole image pipeline is also opt-in — with `S3_BUCKET`
unset, sharp is never exercised.

## heic-to (embedded libheif) — LGPL-3.0

Browser-side HEIC decoding uses [`heic-to`](https://www.npmjs.com/package/heic-to),
which npm declares as **LGPL-3.0** for the whole package (wrapper code and the
embedded [libheif](https://github.com/strukturag/libheif) decoder it bundles;
the shipped `LICENSE` text grants version 3 "or any later version"). The
`heic-to/csp` build embeds the emscripten-compiled libheif decoder directly in
its JavaScript bundle.

Unlike libvips above, this code **does ship to browsers**: it is loaded as a
lazy, dynamically imported chunk (`packages/api/src/lib/asset-image-prepare.ts`)
the first time a user uploads a HEIC file that the browser's native
`createImageBitmap` cannot decode (Chrome/Firefox). The LGPL's obligations are
met by keeping this notice and by shipping the published npm package unmodified
as its own replaceable chunk — the corresponding source is available from the
package's repository and from libheif upstream. If your distribution posture
cannot accept LGPL code in the client bundle, remove the `heic-to` dependency
and the WASM fallback path in `asset-image-prepare.ts`; native-decode browsers
(Safari) keep working.

Docker note: because `heic-to` is a dependency of `packages/api`, it is
**installed** in both the server and worker container images. It is never
**executed** there — nothing in those processes imports `asset-image-prepare` —
so the install is inert weight, accepted rather than hidden behind an extra
workspace package.

## web-tree-sitter and tree-sitter-bash — MIT

The Claude Code PreToolUse hook (`scripts/claude-hooks/pre-tool-use.mjs`) uses
[`web-tree-sitter`](https://www.npmjs.com/package/web-tree-sitter) and
[`tree-sitter-bash`](https://www.npmjs.com/package/tree-sitter-bash) as root
devDependencies to parse Bash at the tool boundary. This is local agent tooling
only — nothing in the web app, server, worker, or native bundles imports these
packages. The shipped `tree-sitter-bash.wasm` grammar is loaded from the
installed package; no native binding is built (`allowBuilds.tree-sitter-bash:
false` in `pnpm-workspace.yaml`).

## caniuse-lite — CC-BY-4.0

Browser-compatibility data from [caniuse.com](https://caniuse.com), used at
build time by the CSS toolchain (browserslist). Attribution-only; the data is
not shipped as part of the application.
