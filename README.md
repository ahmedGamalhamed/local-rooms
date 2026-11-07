# LocalShare

Send messages and files between devices on your local network (Wi‑Fi/LAN).
**One computer hosts. Everyone else joins in a browser** (phone, tablet, Mac or PC), with nothing to install.

## Use it

1. On the host computer, double-click **`dist\LocalShare.exe`**. A console window shows the address, and your browser opens the chat.
2. On any other device on the same network, open that address, for example `http://192.168.0.210:8080`.
3. Type messages, or drag and drop / paste / **+** to send files. Images, video and audio preview inline.

To stop, close the console window on the host. Everyone's chat stops with it.

**First run:** Windows Firewall will ask whether to allow LocalShare. Tick **Private networks** and click Allow, or other devices won't be able to connect.

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
  general\          files shared in /general
  work\             files shared in /work
  .chat\            message history (one file per room; hidden)
```

Chat history and files survive restarts. To clear a room, close LocalShare and delete its folder and its `.chat\<room>.jsonl` file.

### Options

```
LocalShare.exe --port 9000     use a different port (default 8080; the next free port is used if it's taken)
LocalShare.exe --no-open       don't open the browser automatically
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

There's no password. Anyone on the same network who opens the address can see every room and its files. Use it on networks you trust (home or office), not public Wi‑Fi.
