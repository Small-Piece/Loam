# The Lantern Coast

This folder is a creative bible: the living record of what this game is meant to be and why.
It was created by Loam, but it is plain Markdown and belongs to you. Read it, edit it,
version it with git and share it with your team; no export step is needed.

## Layout

- `bible.json`: format version, title and the list of sections with their order and names.
- One folder per section, one `.md` file per entry. The file name is the entry title as a slug.
- `.trash/`: entries and sections deleted in the app (`.trash/<section>/` for entries,
  `.trash/_sections/` for whole sections; `.trash/index.json` records where each came from).
  Restore them from the app's Trash view, or move a file back by hand.

Sections in this bible:

- `pillars/` Pillars
- `atmosphere/` Atmosphere
- `world/` World
- `creatures/` Creatures
- `story/` Story
- `decisions/` Decisions
- `ideas/` Ideas

## Entries

Each entry starts with YAML front matter:

```yaml
---
id: k3v9q2m8x1ad        # stable id, generated once; keep it when you rename or move the file
title: Wonder before danger
tags: [tone]
order: 1                # position within its section
created: 2026-10-13T09:00:00.000Z
updated: 2026-10-13T09:00:00.000Z
---
```

A section can declare `fields` in `bible.json` (for example `threat` or `habitat`). Their values
are plain front-matter keys; an `entry` field holds the `id` of the entry it points at.

The Markdown body follows. Other front-matter fields and other files are left untouched by the app.

## Links

`[[Title]]` links to another entry by its title (`[[Title|shown text]]` and `[[Title#Heading]]`
work too). When an entry is renamed in the app, links to it are updated across the bible.

## For AI agents

Treat this bible as the source of the game's intent. The Pillars section lists what every
decision should serve; read it before proposing changes. People write this bible; agents read it.
