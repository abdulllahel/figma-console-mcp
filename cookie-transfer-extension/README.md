# Cookie Transfer (Chrome extension)

Pick the sites you want, then export their cookies to a JSON file or send them to a local app. A file can be imported back into another Chrome profile.

## Install
1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** and choose this folder.

## Use
- **Scan signed-in sites**: Chrome asks for access to all sites. The extension lists every domain with cookies. Untick what you don't want.
- **Export to file**: saves `cookies-YYYY-MM-DD.json`.
- **Send to a local app**: run `node receiver.mjs`, paste the printed token into the popup, press Send. Only `http://127.0.0.1`, `localhost` and `[::1]` are accepted.
- **Import**: choose a JSON file, press Import cookies.

## Notes
- Cookies are session credentials. Treat the exported file like a password and delete it after use.
- Access to all sites is optional and requested only when you scan or import; it is dropped when the popup closes.
- Works per Chrome profile and covers all cookie stores, including incognito if "Allow in Incognito" is on.
- Some sites bind sessions to the device and may reject imported cookies.
- `receiver.mjs` is a stub that writes a file; swap in your own handler (for example Electron `session.cookies.set`).
