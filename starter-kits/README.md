# Starter kits

A starter kit sets up a new creative bible: its sections, in order, and a template for new
entries in each section. Kits are plain folders, so anyone can add one:

```
starter-kits/<id>/
  kit.json          # id (same as the folder), name, description, order, sections
  templates/<section>.md
```

`kit.json`:

```json
{
  "id": "my-kit",
  "name": "My kit",
  "description": "One line shown when picking a kit.",
  "order": 10,
  "sections": [{ "id": "pillars", "name": "Pillars", "template": "templates/pillars.md" }]
}
```

A section may also list `fields`: properties its entries get, each `{ "key", "label", "type" }`
with type text, number, select, multi-select, entry, entries, date or checkbox. select and
multi-select take `options`; entry and entries may take `section` to limit the choice.

Section ids are folder names: lower case letters, digits and dashes. Every kit should include
`pillars`, `decisions` and `ideas`; the app's decision tools use them. A template is the body a
new entry in that section starts with. Keep templates short: a few headings, not a form.

`"role": "journal"` marks a kit for the study journal instead of a game bible: it is offered only
when creating the journal, and a journal folder opens only from Journal. The `journal` kit is the
one the app uses; it has `sessions`, `topics` and `resources` instead of the decision sections.
