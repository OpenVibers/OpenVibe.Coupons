# Changelog

## Unreleased

- `openvibe-contracts` is pinned to v0.97.0 (and `openvibe-shared` to v2.9.0): all six Coupons capabilities are released there, so the local proposed-id fallback in `server/auth/capabilities.js` is gone and `checkCapability` is the library's check. STATUS.json and the README pins now match package.json; `test/capabilities.test.js` locks the released ids, the delegated check and the Coupons-local install scopes.
- Every page is rendered through `openvibe-publishing/layout` (v1.2.0, on `openvibe-shared/shell` v2.6.0): the head, the Frame, the noscript navigation, the footer and its init come from the shared document; robots and the canonical still come from the indexability gate's decision. The shell adds `web-runtime.js` to every page; the home page's JS budget still holds (5 files, 239.1 KB, 56.3 KB brotli), so no budget was raised.
