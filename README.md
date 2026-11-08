# LocalShare

Send messages and files between devices on your local network (Wi‑Fi/LAN).
**One computer hosts. Everyone else joins in a browser** (phone, tablet, Mac or PC), with nothing to install.

## Use it

1. On the host computer, double-click **`dist\LocalShare.exe`**. A console window shows the address, and your browser opens the chat.
2. On any other device on the same network, open that address, for example `http://192.168.0.210:8080`.
3. Type messages, or drag and drop / paste / use the paperclip to send files and folders. Images, video and audio preview inline. Pasted files wait above the message box until you press Send.
4. Several images or files sent one after another show as one album or group with **Download all**, which saves them as one .zip. This works in remote rooms too.

## Passcode

By default anyone on your network can join. To lock LocalShare:

1. On the **host computer** (the one running LocalShare), click the **lock icon** next to your name at the bottom of the rooms list.
2. Type a passcode (at least 4 characters) and click **Save**.

Other devices now see a lock screen and must enter the passcode once; they stay signed in after that. The host computer never needs it.

- **Change it:** devices still using the old passcode are signed out at once and must enter the new one.
- **Remove it:** click the lock icon and choose **Remove passcode**.
- **Wrong guesses:** after 5 wrong tries, that device must wait 30 seconds, and the wait doubles with each further wrong try (up to 15 minutes).
- **Forgot it?** Just set a new one from the host computer.

The passcode itself isn't stored, only a scrambled version of it, in `LocalShare Files\.chat\config.json`.

## Folders

Drop a folder onto the chat, or click the paperclip and choose **Folder**. The folder is sent with its sub-folders kept intact (minus junk, see below), and shows up in the chat as one card:

- **Download .zip** gets the whole folder as a zip file (no size limit; works for folders over 4 GB).
- **Show files** lists everything inside, and each file can be downloaded on its own.
- **Save into folder…** copies the files straight into a folder you pick, replacing ones that changed (see below for where this button appears).

Picking a folder isn't possible on iPhone/iPad (Safari doesn't support it); the paperclip there sends files only.

To stop, close the console window on the host. Everyone's chat stops with it.

**First run:** Windows Firewall will ask whether to allow LocalShare. Tick **Private networks** and click Allow, or other devices won't be able to connect.

### Junk is left out

Sending a code project shouldn't mean sending 500 MB of dependencies. When you send a folder, LocalShare leaves out:

- `node_modules`, `.git`, `.svn`, `.hg`, `__pycache__`, `.venv`, `venv`, `.pnpm-store`, `.next`, `.nuxt`, `.turbo`, `.cache`, `.parcel-cache`, `.gradle`, `.vs`, and `Thumbs.db`, `.DS_Store`, `desktop.ini` files
- anything the folder's own **`.gitignore`** files list (for example `dist/`, `bin/`, `*.log`), following the same rules as git

The folder card says what was left out, for example *Left out: node_modules/, .git/, .env*. Most `.gitignore` files list `.env` and other local secrets, so those are left out too.

To send everything, click the paperclip and untick **Skip junk folders**. The setting is remembered on that device.

### Pull a folder onto another PC

On the receiving PC, put a copy of `server.js` (it needs nothing else, just Node.js 22+) or of `LocalShare.exe`. Then one command copies a shared folder into a folder on that PC:

```
node server.js pull work my-project D:\code\my-project
LocalShare.exe pull work my-project D:\code\my-project
```

- It finds the LocalShare host on the network by itself. If it can't (some networks block this), give the address instead: `pull http://192.168.0.210:8080/work my-project D:\code\my-project`.
- If you sent `my-project` several times, it takes the newest copy (`my-project (2)` and so on).
- Files that haven't changed are skipped; changed ones are replaced. Files that only exist on this PC are left alone, and nothing is deleted.
- With a passcode on, it asks for it (or add `--passcode 1234`).
- Leave out the destination to use a folder with the same name in the current directory.

**Save into folder… in the browser** does the same from a folder card, in Chrome or Edge. Browsers only allow it on secure pages, so the button shows on the host computer (`http://localhost:8080`) but not on other devices. To get it on another PC, open `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (or `edge://flags/…`), add the LocalShare address, for example `http://192.168.0.210:8080`, set it to **Enabled** and restart the browser.

## Rooms

Rooms keep separate conversations and files apart. Room names are short and easy to type: lowercase letters, numbers and dashes.

- **Join or create a room:** type a name in the box under **Rooms**, for example `work`. Typing `Family Pics` becomes `family-pics`.
- **Go straight to a room:** add its name to the address, for example `http://192.168.0.210:8080/work`.
- The **Files** panel shows the link to the current room (tap to copy), a **QR code** of it to scan with a phone camera, and every file shared in it.
- Rooms with new messages show a count. Everyone starts in `general`.

## Long messages

There's no limit on message length, file size, or number of messages.

Put code between lines of three backticks and it shows in a monospace box with its indentation kept and its own **Copy** button. A word after the opening backticks (` ```powershell `) labels the box. Single backticks (`` `like this` ``) mark inline code.

Long messages are shown collapsed, with **Show all**, **Copy** and **Save as .txt** buttons. Older messages load with **Load older messages** at the top of a room.

## Where things are saved

Everything is in a **`LocalShare Files`** folder next to the exe:

```
LocalShare Files\
  general\          files and folders shared in /general
  work\             files shared in /work
  .chat\            message history (one file per room; hidden)
```

Chat history and files survive restarts. To clear a room, close LocalShare and delete its folder and its `.chat\<room>.jsonl` file.

### Options

```
LocalShare.exe --port 9000     use a different port (default 8080; the next free port is used if it's taken)
LocalShare.exe --no-open       don't open the browser automatically
LocalShare.exe --passcode 1234 set the passcode (saved; --passcode "" removes it)
```

## Portable

`LocalShare.exe` is self-contained (Node.js is bundled into it). Copy it to a USB stick or any folder on any Windows PC and run it. Nothing is installed. Its data folder travels with it.

You can also run it without building: `node server.js` (Node 22+, any OS).

## Build

```
powershell -ExecutionPolicy Bypass -File build.ps1
```

This produces `dist\LocalShare.exe`. The only source files are `server.js` (the server) and `index.html` (the UI). There are no dependencies.

## Remote rooms (over the internet)

LocalShare itself only works on one network. For devices that can't reach each other directly (a PC on a VPN that blocks the local network, a phone on mobile data, someone in another city), there's a separate **LocalShare Remote** in [`remote/`](remote), hosted on Cloudflare Workers. It's a different site with its own rooms; local rooms and remote rooms don't mix.

### Use it

1. Open the site (for example `https://localshare-remote.<your-subdomain>.workers.dev`) and click **Make a room**. Give it a name if you like.
2. The **Files** panel shows the room's link and a QR code. Open that link on the other device.
3. Chat and share files as in LocalShare.

A room's address has a random key, like `/r/k7f3-m9q2-x8wa`. **The link is the only way in**, so anyone who has it can join, and nobody can find a room without it. Your device remembers the rooms you've joined under **Your rooms**; removing one there only forgets it on that device.

### Files are never stored online

Sharing a file only posts its card in the room. When someone downloads it, the bytes stream from the sharing browser through the Worker straight into their download, and nothing is kept. So:

- **Keep the page open** while others need the files. Closing or reloading it stops sharing (the page asks before you leave). Files from a closed page are greyed out with a note; they're back if the same page reconnects after a network drop.
- A phone that locks its screen or switches apps usually drops the connection, so share from a phone only while it stays on the page.
- Downloads are as fast as the sender's upload. Several people can download at once.
- Folders work as in LocalShare: **Download .zip** (made on the fly by the sender), **Show files**, and **Save into folder…** (this works on every computer, since the site is `https://`).

Messages *are* stored, in the room on Cloudflare: the last 5,000 per room, up to 500,000 characters each. A room nobody opens for 30 days is deleted.

Traffic is encrypted between each browser and Cloudflare (`https://`). Cloudflare can see it in passing, as with any site it hosts.

### Deploy it

Needs Node.js and a Cloudflare account (the free plan is enough).

```
cd remote
npx wrangler login
npx wrangler deploy
```

Wrangler prints the site's address. To try it locally first, run `npx wrangler dev` and open `http://localhost:8787`.

The files are `remote/worker.js` (the Worker, plus one Durable Object per room) and `remote/index.html` (the page, which reuses most of LocalShare's `index.html`).

## Notes

Without a passcode, anyone on the same network who opens the address can see every room and its files. Set a passcode if other people share your network, and don't use LocalShare on public Wi‑Fi.

Everything travels unencrypted (plain `http://`), as with most local network tools. The passcode keeps people out, but someone who can watch the network traffic could still see what's sent.
