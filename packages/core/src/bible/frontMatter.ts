import { CORE_SCHEMA, load } from 'js-yaml'
import { linkTargets } from './links.ts'
import type { ParsedEntry } from './types.ts'

/**
 * An entry file cut into its parts. Joining head, frontMatter, close and body
 * gives back the exact original text.
 */
export interface EntryFile {
  /** The opening "---" line with its line break, or '' when there is no front matter. */
  head: string
  /** Text between the fences, each line with its line break. */
  frontMatter: string
  /** The closing fence line with its line break. */
  close: string
  body: string
  eol: '\n' | '\r\n'
}

const OPENING = /^(?:﻿)?---[ \t]*(\r?\n)/
const CLOSING = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

export function splitEntryFile(text: string): EntryFile {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const opening = OPENING.exec(text)
  if (!opening) return { head: '', frontMatter: '', close: '', body: text, eol }
  const head = opening[0]
  let at = head.length
  while (at <= text.length) {
    const rest = text.slice(at)
    const closing = CLOSING.exec(rest)
    if (closing) {
      return {
        head,
        frontMatter: text.slice(head.length, at),
        close: closing[0],
        body: rest.slice(closing[0].length),
        eol,
      }
    }
    const next = text.indexOf('\n', at)
    if (next === -1) break
    at = next + 1
  }
  // An opening fence that never closes is body text, not front matter.
  return { head: '', frontMatter: '', close: '', body: text, eol }
}

export function joinEntryFile(file: EntryFile): string {
  return file.head + file.frontMatter + file.close + file.body
}

/** Front-matter fields, or {} when there are none or the YAML does not parse. */
export function readFields(frontMatter: string): Record<string, unknown> {
  if (frontMatter.trim() === '') return {}
  try {
    const value = load(frontMatter, { schema: CORE_SCHEMA })
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const PLAIN_SAFE = /^[\p{L}\p{N}_][\p{L}\p{N} _.,'()&+/-]*$/u

/** A YAML scalar for a string: plain when that reads back the same, double-quoted otherwise. */
export function yamlString(value: string): string {
  if (PLAIN_SAFE.test(value) && !value.endsWith(' ')) {
    const back = readFields(`v: ${value}\n`)['v']
    if (back === value) return value
  }
  // A JSON string is a valid YAML double-quoted scalar.
  return JSON.stringify(value)
}

export function yamlList(values: readonly string[]): string {
  return `[${values.map(yamlString).join(', ')}]`
}

/**
 * Sets top-level keys, each to a YAML value written on one line. An existing
 * key is replaced in place (with any indented lines that continue it); a new
 * key is added at the end. Every other line is left exactly as it was.
 */
export function setFields(
  frontMatter: string,
  fields: ReadonlyArray<readonly [key: string, yamlValue: string]>,
  eol: '\n' | '\r\n',
): string {
  const lines = frontMatter === '' ? [] : frontMatter.split(/(?<=\n)/)
  for (const [key, value] of fields) {
    const line = value === '' ? `${key}:${eol}` : `${key}: ${value}${eol}`
    const start = lines.findIndex((text) => new RegExp(`^${key}[ \\t]*:`).test(text))
    if (start === -1) {
      if (lines.length > 0 && !lines[lines.length - 1]!.endsWith('\n')) {
        lines[lines.length - 1] += eol
      }
      lines.push(line)
      continue
    }
    let end = start + 1
    const opensBlock = /:[ \t]*(?:[|>][^\n]*)?\r?\n$/.test(lines[start]!)
    while (end < lines.length) {
      const next = lines[end]!
      const continues =
        /^[ \t]/.test(next) || (opensBlock && /^-([ \t]|\r?\n)/.test(next)) || /^\r?\n$/.test(next)
      if (!continues) break
      end++
    }
    // Blank lines after the value belong to whatever follows.
    while (end > start + 1 && /^\r?\n$/.test(lines[end - 1]!)) end--
    lines.splice(start, end - start, line)
  }
  return lines.join('')
}

function stringField(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return null
}

/** Reads an entry file; `fallbackTitle` (from the file name) is used when it has no title. */
export function parseEntry(text: string, fallbackTitle: string): ParsedEntry {
  const file = splitEntryFile(text)
  const fields = readFields(file.frontMatter)
  const rawTags = fields['tags']
  // "tags: tone" typed by hand is read as one tag.
  const tags = (Array.isArray(rawTags) ? rawTags : typeof rawTags === 'string' ? [rawTags] : [])
    .filter((tag): tag is string | number => typeof tag === 'string' || typeof tag === 'number')
    .map(String)
  const order = typeof fields['order'] === 'number' ? fields['order'] : null
  const title = stringField(fields, 'title')?.trim()
  return {
    id: stringField(fields, 'id'),
    title: title ? title : fallbackTitle,
    tags,
    order,
    created: stringField(fields, 'created'),
    updated: stringField(fields, 'updated'),
    body: file.body,
    links: linkTargets(file.body),
    fields,
  }
}
