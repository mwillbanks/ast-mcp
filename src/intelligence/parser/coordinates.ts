import { createHash } from "node:crypto";
import type { Range as AstGrepRange } from "@ast-grep/napi";
import type { ExactSourceRange, SourceCoordinate } from "./types.ts";

const utf8Length = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

export class SourceCoordinateIndex {
  readonly source: string;
  readonly #byteOffsets: number[];
  readonly #characterOffsets: number[];
  readonly #lineStarts: number[];

  constructor(source: string) {
    this.source = source;
    this.#byteOffsets = new Array(source.length + 1).fill(0);
    this.#characterOffsets = new Array(source.length + 1).fill(0);
    this.#lineStarts = [0];
    let byteOffset = 0;
    let characterOffset = 0;
    let index = 0;
    while (index < source.length) {
      const codePoint = source.codePointAt(index);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      const width = character.length;
      this.#byteOffsets[index] = byteOffset;
      this.#characterOffsets[index] = characterOffset;
      if (width === 2) {
        this.#byteOffsets[index + 1] = byteOffset;
        this.#characterOffsets[index + 1] = characterOffset;
      }
      byteOffset += utf8Length(character);
      characterOffset += 1;
      index += width;
      this.#byteOffsets[index] = byteOffset;
      this.#characterOffsets[index] = characterOffset;
      if (character === "\n") this.#lineStarts.push(index);
    }
  }

  coordinateAt(utf16Offset: number): SourceCoordinate {
    if (
      !Number.isInteger(utf16Offset) ||
      utf16Offset < 0 ||
      utf16Offset > this.source.length
    ) {
      throw new RangeError("UTF-16 offset is outside the source");
    }
    let low = 0;
    let high = this.#lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.#lineStarts[middle] ?? 0) <= utf16Offset) low = middle;
      else high = middle;
    }
    const lineStart = this.#lineStarts[low] ?? 0;
    return {
      byteOffset: this.#byteOffsets[utf16Offset] ?? 0,
      characterOffset: this.#characterOffsets[utf16Offset] ?? 0,
      column: Array.from(this.source.slice(lineStart, utf16Offset)).length,
      line: low,
      utf16Column: utf16Offset - lineStart,
      utf16Offset,
    };
  }

  range(startUtf16: number, endUtf16: number): ExactSourceRange {
    if (endUtf16 < startUtf16) throw new RangeError("Range end precedes start");
    const startCoordinate = this.coordinateAt(startUtf16);
    const endCoordinate = this.coordinateAt(endUtf16);
    return {
      end: { column: endCoordinate.column, line: endCoordinate.line },
      endByte: endCoordinate.byteOffset,
      endCoordinate,
      start: { column: startCoordinate.column, line: startCoordinate.line },
      startByte: startCoordinate.byteOffset,
      startCoordinate,
    };
  }

  fromAstRange(range: AstGrepRange): ExactSourceRange {
    return this.range(range.start.index, range.end.index);
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableNodeId(
  sourceDigest: string,
  kind: string,
  startUtf16: number,
  endUtf16: number,
): string {
  return sha256(JSON.stringify([sourceDigest, kind, startUtf16, endUtf16]));
}
