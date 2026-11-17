# Third-party notices

ai-modeling is distributed under the Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). The adapted portions identified below retain their original licenses and notices. External services and assets are outside the scope of the project license.

Studio request contracts, pricing formulas, upload and postprocessing behavior were adapted from these MIT projects. The task service, SQLite recovery, credential bridge, MCP/CLI integration and tests are maintained independently here.

- `GrinZero/tripo-studio-plugin`, commit `8bf893e9bda2383a6792d36e6e21b6af57e8e5b5` — Copyright (c) 2026 tripo-studio-plugin contributors.
- `limeflash/tripo-studio-mcp`, commit `cfaa609a8afef0bfb88d11538b2e17cc8c4fa650` — Copyright (c) 2026 limeflash. Its notice also attributes portions to tripo-studio-plugin contributors.

We did not incorporate the latter project's Blender worker, meshoptimizer decoder or bundled UI, nor any source from tripo2api whose licensing was not confirmed. Runtime and development package licenses remain in their respective installed distributions.

## Official CLI compatibility contracts

Command names, help text and public full-MCP schemas in `cli/compat/help-contract.ts` and `cli/compat/full-contract.ts` are adapted from `tripo-cli@0.11.2` (npm), whose published package metadata declares the MIT license and repository `https://github.com/vast-enterprise/Tripo-API-CLI`. The published archive does not include a separate LICENSE or copyright-holder notice; no additional copyright attribution is invented here. The MIT permission and warranty terms below are retained with these adapted portions. Runtime calls and backend-specific descriptions are implemented here for Studio, and do not include the official API-wallet client.

The local preview uses `@google/model-viewer@4.4.0` under its bundled Apache-2.0 license; its distribution and notice remain in the installed dependency.

## Local processing dependencies and assets

The Blender worker, CPU UV projection, brush rasterization, rendering orchestration and static 3MF writer are maintained independently here; they are not the worker from the referenced plugin. Blender and FFmpeg are external executables selected by the caller and are not bundled. Their licenses apply to their own distributions.

Runtime packages used for local processing include `@gltf-transform/core` / `extensions` (MIT), `meshoptimizer` (MIT), `gl-matrix` (MIT), `qrcode` (MIT), and `sharp` (Apache-2.0). Native transitive distributions such as libvips retain their own notices in their installed packages. The locked package distributions remain the authority for exact license text and version.

Published runtime archives include the reviewed portable JavaScript dependencies under `node_modules/`, together with their original license and notice files. Platform-specific optional packages are installed by npm at their reviewed exact versions. Bundled third-party code retains its own licenses; this project's Apache-2.0 license does not replace them. The distribution manifest identifies the production dependency versions and integrity values.

Share template backgrounds, stickers, logo and video-credit art are downloaded on demand from the official Studio static resource URLs. These assets are not included in this package and are not relicensed under this project’s license or the MIT terms below. Template layout and request contracts were observed in publicly served webpage code; the Studio application or its minified bundles are not included in the deliverable. Tripo product names are used to identify compatibility, not official affiliation.

## Studio frontend conversion runtime

The optional frontend exporter loads the exact Studio-hosted `assimpjs-meshopt` JavaScript/WASM version observed in the webpage, verifies its length and SHA-256, and runs it in an isolated worker. These two external files, the webpage worker, and minified Studio application bundles are **not included** in this package or relicensed here. The caller may supply the exact verified runtime files in a directory or use the verified local cache. Availability and terms of the upstream runtime remain those of its provider. The package contains independently maintained orchestration, glTF normalization, validation and recovery code; see [frontend export boundaries](docs/compatibility.md) for its bounds.

## Browser authentication dependency

Browser authentication uses `playwright-core@1.65.1` (Apache-2.0) to control an installed Chromium browser. Its license and notices remain in the installed package. No browser binary, regular user profile, or saved browser authentication state is bundled. The login broker, account verification and continuation policy are independently maintained here.

## MIT License

Copyright (c) 2026 tripo-studio-plugin contributors

Copyright (c) 2026 limeflash

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
