# Changelog

All notable changes to Loam are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.2

### Fixed

- Fixed Library panel thumbnails with many references: beside a canvas and in the Bible, every reference now shows as a full thumbnail instead of a thin line.

### Added

- Boards can be reordered: drag a board in the sidebar, or right-click it and choose Move up or Move down. New boards go to the end of the list.

## 0.1.1

### Fixed

- The Website button in About now opens the right page.

## 0.1.0 — first public release

Loam is a free, open-source desktop app for indie developers who make games creatively and artistically. It keeps your references, your game's intent and your learning in one place, as files you own.

### What you can do

- **Collect references.** Drop or paste images into the Library. Add titles, notes, sources and tags, filter by tags and search the text. Deleted references wait in the trash until you empty it.
- **Arrange them on boards.** Canvas boards in the style of a moodboard: move, scale and layer images, group them and add notes. Each board remembers its view.
- **Look closely.** A full-screen viewer with zoom and pan for large images.
- **Write down your game's intent.** A creative bible made from a starter kit (blank, action roguelike, atmospheric horror, cozy sim, narrative adventure): design pillars and sections such as world, creatures, characters and story, with fields per section and `[[links]]` between entries.
- **Keep your decisions honest.** A decision log with dates, statuses and the pillars each decision serves, a timeline, an idea parking lot you can promote from, and a review of anything that names no pillar.
- **See yourself learn.** A study journal with practice sessions, topics, a calendar, side-by-side comparison of your practice work over time and lists of learning resources. No streaks.
- **Try the sample bible.** "The Lantern Coast", an original sample made with the atmospheric horror kit, opens from the Bible's start screen into a folder you choose.
- **Optional helpers.** Tag suggestions for your references and recaps of your study sessions, from a small model that runs on your computer. Off by default; nothing is applied without your click.

### Privacy

- **Local-first.** Your library and settings live in `%LOCALAPPDATA%\Loam` on your computer. Bibles and journals are plain Markdown folders wherever you put them.
- **No telemetry.** Loam sends nothing about you or your work anywhere. There are no accounts and no analytics.
- **Nothing goes online unless you ask.** The only network access in this version is downloading the optional local model, after you click Download and see exactly which files will be fetched. The model then runs offline on your computer.

### Known limits

- Windows 10 and 11 only (64-bit).
- The installer is not code-signed yet, so Windows SmartScreen shows a warning the first time; choose "More info", then "Run anyway".
- No automatic updates: download new versions from the releases page.
- The optional helpers need a GPU with Vulkan support and about 4.5 GB of free video memory, and a one-time 2.8 GB download.
- The interface is in English only.

### For users of the earlier private builds (UnrealManager)

On its first start, Loam copies your data from `%LOCALAPPDATA%\UnrealManager` to `%LOCALAPPDATA%\Loam` and checks the copy. The old folder is left untouched; About shows where it is, and you can delete it by hand once everything looks right.
