# Privacy

Loam does not send your data to other systems. It has no accounts, no telemetry, no analytics, no crash reporting and no automatic update checks.

## Where your data lives

- **Library, boards and settings:** in `%LOCALAPPDATA%\Loam` on your computer.
- **Bibles and journals:** plain Markdown folders, wherever you choose to put them.

Nothing of this leaves your computer unless you copy it somewhere yourself.

## The only network action: the optional model download

The optional helpers (tag suggestions and study recaps) are off by default. To use them, you turn them on in Settings and start the model download yourself.

- Before anything is fetched, Loam shows every file it will download, with its source address and size.
- The files come from their publishers: the llama.cpp runtime from GitHub and the model from Hugging Face. As with any download, those sites see a request for the file.
- Nothing of yours is sent. Loam checks each file against a checksum built into the app.

After the download, the model runs on your computer only. Loam starts it as a local process that listens only on your own machine (127.0.0.1) and works offline.

## Links

Web links open in your web browser only when you click them, and links inside a bible or journal ask first. What happens on those websites is up to them.

## Questions

Ask in a GitHub issue, or report a problem privately through the repository's [Security tab](https://github.com/Small-Piece/Loam/security).
