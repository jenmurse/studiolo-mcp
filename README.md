# Studiolo MCP

Let your AI assistant search, look at, and organize everything you save in Studiolo.

[Studiolo](https://www.withstudiolo.com/?from=github) is a Mac app for everything you save: screenshots, saved pages, images, and the downloads you meant to get to. It files them into your own folders, finds them by words, meaning, picture, or color, and lays them out on canvases. This is its MCP server. With it, Claude, Cursor, or any other MCP client can work with your library:

- "Find the screenshots I saved last week."
- "Look at this canvas and tell me what these have in common."
- "Name and file everything in my Inbox."

**This server needs the Studiolo app.** It is a thin client of the app running on your own Mac, so it does nothing on its own. Studiolo is in a private alpha; [join the waitlist](https://www.withstudiolo.com/?from=github) to get it.

## Tools

| Tool | What it does |
|---|---|
| `search_inspo` | Searches the library by text, and also by meaning and by picture. |
| `view_inspo` | Returns the images themselves, so the assistant can actually look at them. |
| `recent_inspo` | The most recently saved items, newest first. |
| `list_folders` | The folders the library reads, with item counts. |
| `list_canvases` | Your canvases, by project, with how many items each holds. |
| `canvas_items` | What is on one canvas, in reading order, with each item's description. |
| `describe_item` | Writes the name and note for one item, which makes it findable. |
| `rename_file` | Renames a file on disk. |
| `move_file` | Files an item into a different folder. |

It cannot delete anything or change a canvas, and it will not move a file that is already on one.

## Privacy

Everything stays on your Mac. The server talks only to Studiolo at `localhost`, and Studiolo sends nothing home. What your assistant does with what it sees is between you and your assistant.

## Setup

1. Install Studiolo and keep it open while you use your assistant.
2. In Studiolo, open **Settings › AI assistant**. It gives the steps for your assistant:
   - **Claude Desktop:** double-click `studiolo.mcpb`, which Settings shows you in Finder.
   - **Claude Code:** one command to paste into Terminal.
   - **Cursor and others:** a block to paste into their MCP config file.

### From this repo

```bash
npm install
npm run build
```

Then point your MCP client at `node /path/to/studiolo-mcp/dist/index.js`. Studiolo is expected at `http://localhost:4444`; set `INSPO_CANVAS_URL` if yours runs elsewhere.

## Connected it?

[Tell us](https://www.withstudiolo.com/connected?from=github). Studiolo counts nothing, so this is the only way we know it works for you. It is one field and asks for nothing about you.

## License

MIT for this server. The Studiolo app is a separate product and is not open source.

Made by [Mer So Studio](https://www.withstudiolo.com/?from=github).
