/**
 * What the toast says after a copy. Other apps get one image: the first that
 * can be shared; Loam's own paste gets all of them.
 */
export function copiedMessage(copied: readonly number[], sharedId: number | null): string {
  const count = copied.length
  if (count === 0) return 'Nothing was copied (those references are no longer in the Library)'
  const what = count === 1 ? 'image' : `${count} images`
  if (sharedId === null) {
    return `Copied ${what} for Loam only (other apps take PNG and JPEG images only)`
  }
  if (count === 1) return 'Copied image'
  return sharedId === copied[0]
    ? `Copied ${what} (other apps get the first)`
    : `Copied ${what} (other apps get the first PNG or JPEG)`
}
