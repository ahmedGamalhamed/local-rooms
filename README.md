# LocalShare

Send messages and files between devices on your local network (Wi‑Fi/LAN).
**One computer hosts. Everyone else joins in a browser** (phone, tablet, Mac or PC), with nothing to install.

## Use it

1. On the host computer, double-click **`dist\LocalShare.exe`**. A console window shows the address, and your browser opens the chat.
2. On any other device on the same network, open that address, for example `http://192.168.0.210:8080`.
3. Type messages, or drag and drop / paste / use the paperclip to send files and folders. Images, video and audio preview inline.

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

Picking a folder isn't possible on iPhone/iPad (Safari doesn't support it); the paperclip there sends files only.

To stop, close the console window on the host. Everyone's chat stops with it.

**First run:** Windows Firewall will ask whether to allow LocalShare. Tick **Private networks** and click Allow, or other devices won't be able to connect.

### Junk is left out

Sending a code project shouldn't mean sending 500 MB of dependencies. When you send a folder, LocalShare leaves out:

- `node_modules`, `.git`, `.svn`, `.hg`, `__pycache__`, `.venv`, `venv`, `.pnpm-store`, `.next`, `.nuxt`, `.turbo`, `.cache`, `.parcel-cache`, `.gradle`, `.vs`, and `Thumbs.db`, `.DS_Store`, `desktop.ini` files
- anything the folder's own **`.gitignore`** files list (for example `dist/`, `bin/`, `*.log`), following the same rules as git

The folder card says what was left out, for example *Left out: node_modules/, .git/, .env*. Most `.gitignore` files list `.env` and other local secrets, so those are left out too.

To send everything, click the paperclip and untick **Skip junk folders**. The setting is remembered on that device.

## Rooms

Rooms keep separate conversations and files apart. Room names are short and easy to type: lowercase letters, numbers and dashes.

- **Join or create a room:** type a name in the box under **Rooms**, for example `work`. Typing `Family Pics` becomes `family-pics`.
- **Go straight to a room:** add its name to the address, for example `http://192.168.0.210:8080/work`.
- The **Files** panel shows the link to the current room (tap to copy) and every file shared in it.
- Rooms with new messages show a count. Everyone starts in `general`.

## Long messages

There's no limit on message length, file size, or number of messages. Long messages are shown collapsed, with **Show all**, **Copy** and **Save as .txt** buttons. Older messages load with **Load older messages** at the top of a room.

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

## Notes

Without a passcode, anyone on the same network who opens the address can see every room and its files. Set a passcode if other people share your network, and don't use LocalShare on public Wi‑Fi.

Everything travels unencrypted (plain `http://`), as with most local network tools. The passcode keeps people out, but someone who can watch the network traffic could still see what's sent.
