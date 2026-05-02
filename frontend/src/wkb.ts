// Parses an EWKB hex string for a POINT (as returned by PostGIS GEOGRAPHY
// columns over PostgREST) into [lng, lat]. Supports both little- and
// big-endian, with or without the SRID flag.
export function parsePointHex(hex: string): [number, number] | null {
  if (!hex || hex.length < 42) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const view = new DataView(bytes.buffer);
  const little = bytes[0] === 1;
  const typeWord = view.getUint32(1, little);
  const hasSRID = (typeWord & 0x20000000) !== 0;
  const offset = hasSRID ? 9 : 5;
  if (bytes.length < offset + 16) return null;
  const lng = view.getFloat64(offset, little);
  const lat = view.getFloat64(offset + 8, little);
  return [lng, lat];
}
