# Engine source and license

This distribution includes Rapfi source in `rapfi-source.tar.gz`, corresponding to commit `1387d11312190ec66665d361ff07a7c70221b78a`. It also includes the freestyle network and classical model/config from Rapfi networks commit `7eeb19b55219a48138756293f92211a1539bab4d`. Rapfi is GPL-3.0-or-later; see COPYING.txt. The network is CC0; see NETWORK_LICENSE.txt.

The source archive includes the build's changes: `Rapfi/CMakeLists.txt` disables Closure (`--closure=0`) and `Networks/wasm_preloads.txt` specifies explicit virtual filesystem destinations. `Networks/config.toml` uses only the included freestyle model, sets coordinate conversion to `none`, and contains the accompanying config settings. The worker adapter is source in `../engine-worker.js`. Rebuild with Emscripten 4.0.20, CMake and `../build-engine.sh`. The bundled build uses `-O3`, SIMD128, LTO and single-thread and pthread variants. Both variants share the same data package.

Upstream: https://github.com/dhbloo/rapfi and https://github.com/dhbloo/rapfi-networks (the exact pinned commits above are authoritative).
