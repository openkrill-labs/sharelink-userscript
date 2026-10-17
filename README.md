# OpenKrill Share Link Resolver (userscript)

This userscript adds a Resolve button to public Google Drive and Baidu Netdisk share pages.

On Google Drive, it turns a file, folder, Docs, Sheets or Slides link into direct download URLs. You can send each URL to Aria2 or Motrix with one click, or copy a ready `curl` or `aria2c` line. On Baidu Netdisk, it lists the files in a share, with sizes and dates. The text shows in English or Chinese, following your browser language.

It works with public links only, the ones anyone with the link can open. It doesn't sign in for you, and it doesn't get around passwords or private shares.

## Install

1. Install a userscript manager, such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [openkrill-sharelink.user.js](https://tools.openkrill.app/sharelink/openkrill-sharelink.user.js), and your manager offers to install it.
3. Open a share link and press Resolve at the bottom right of the page.

Your manager checks for updates on its own schedule. The script itself never does.

## What it sends, and to whom

- To the drive you're already on: the script asks `drive.google.com`, `drive.usercontent.google.com` and `docs.google.com`, or `pan.baidu.com`, for the same file list and download details the page shows any visitor.
- To your own computer, only when you press Send: the Aria2 and Motrix buttons call the download manager on `localhost` (ports 6800 and 16800) with the file URL. If your Aria2 needs an RPC secret, the script keeps it in your userscript manager's storage on your machine.
- Nothing to OpenKrill: the script has no analytics, no ads and no calls to our servers. It runs fully in your browser.

## Web version, API and MCP server

The same resolver also runs as a web page, an HTTP API and an MCP server for AI agents. All of them are at [tools.openkrill.app/sharelink](https://tools.openkrill.app/sharelink).

## Source

`openkrill-sharelink.user.js` in this repository is the readable build of the script, and it's the same file served at the address above. Greasy Fork syncs from that address on its own, and this copy gets a new commit with each release. For bugs and ideas, open an issue here.

## License

[MIT](LICENSE)
