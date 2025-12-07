# Xray Config Generator & Editor

A web-based tool to visualize `geosite.dat`/`geoip.dat` files and edit `config.json` for Xray-core with smart autocomplete features.

## Features
- **Visual Editor:** Drag & drop rules reordering.
- **Smart Autocomplete:** Search domains inside your GeoSite files.
- **Tag Management:** Auto-extracts outbound tags from your config.
- **Parser:** Reads compiled `.dat` files via Protobuf.

## Usage
1. Open the [Live Demo](https://bropines.github.io/xray-config-generator/) (Link will work after setup).
2. Load your `config.json`.
3. Load `geosite.dat` and `geoip.dat` for autocomplete magic.
4. Edit rules and export.