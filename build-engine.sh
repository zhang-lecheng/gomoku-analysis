#!/usr/bin/env bash
# Rebuild the bundled single-thread SIMD engine. Requires Emscripten 4.0.20 and CMake.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$ROOT/engine/rapfi-source.tar.gz" -C "$WORK"
emcmake cmake -S "$WORK/Rapfi" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release -DNO_COMMAND_MODULES=ON -DNO_MULTI_THREADING=ON -DUSE_WASM_SIMD=ON
cmake --build "$WORK/build" -j "${JOBS:-4}"
cp "$WORK/build"/rapfi-single-simd128.{js,wasm,data} "$ROOT/engine/"
emcmake cmake -S "$WORK/Rapfi" -B "$WORK/build-multi" -DCMAKE_BUILD_TYPE=Release -DNO_COMMAND_MODULES=ON -DNO_MULTI_THREADING=OFF -DUSE_WASM_SIMD=ON
cmake --build "$WORK/build-multi" -j "${JOBS:-4}"
cmp "$WORK/build-multi/rapfi-multi-simd128.data" "$ROOT/engine/rapfi-single-simd128.data"
cp "$WORK/build-multi"/rapfi-multi-simd128.{js,wasm} "$ROOT/engine/"
