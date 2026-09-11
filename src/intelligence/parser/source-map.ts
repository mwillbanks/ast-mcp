import { SourceCoordinateIndex } from "./coordinates.ts";
import type { ExactSourceRange } from "./types.ts";

export interface EmbeddedSourceMapSegment {
  embeddedEnd: number;
  embeddedStart: number;
  hostEnd: number;
  hostStart: number;
}

function validateSegments(segments: readonly EmbeddedSourceMapSegment[]): void {
  let previousEmbeddedEnd = 0;
  let previousHostEnd = 0;
  for (const [index, segment] of segments.entries()) {
    if (
      !Number.isInteger(segment.embeddedStart) ||
      !Number.isInteger(segment.embeddedEnd) ||
      !Number.isInteger(segment.hostStart) ||
      !Number.isInteger(segment.hostEnd) ||
      segment.embeddedStart < 0 ||
      segment.hostStart < 0 ||
      segment.embeddedEnd < segment.embeddedStart ||
      segment.hostEnd < segment.hostStart
    )
      throw new TypeError("Source-map segments require valid ranges");
    if (
      segment.embeddedEnd - segment.embeddedStart !==
      segment.hostEnd - segment.hostStart
    ) {
      throw new TypeError(
        "Lossless source-map segments must have equal lengths",
      );
    }
    if (
      index > 0 &&
      (segment.embeddedStart < previousEmbeddedEnd ||
        segment.hostStart < previousHostEnd)
    ) {
      throw new TypeError(
        "Source-map segments must be ordered and non-overlapping",
      );
    }
    previousEmbeddedEnd = segment.embeddedEnd;
    previousHostEnd = segment.hostEnd;
  }
}

function translateRange(
  start: number,
  end: number,
  segments: readonly EmbeddedSourceMapSegment[],
  direction: "embedded-to-host" | "host-to-embedded",
): readonly [number, number] | null {
  for (const segment of segments) {
    const sourceStart =
      direction === "embedded-to-host"
        ? segment.embeddedStart
        : segment.hostStart;
    const sourceEnd =
      direction === "embedded-to-host" ? segment.embeddedEnd : segment.hostEnd;
    if (start < sourceStart || end > sourceEnd) continue;
    const targetStart =
      direction === "embedded-to-host"
        ? segment.hostStart
        : segment.embeddedStart;
    return [targetStart + start - sourceStart, targetStart + end - sourceStart];
  }
  return null;
}

export class EmbeddedSourceMap {
  readonly hostSource: string;
  readonly embeddedSource: string;
  readonly segments: readonly EmbeddedSourceMapSegment[];
  readonly #hostIndex: SourceCoordinateIndex;
  readonly #embeddedIndex: SourceCoordinateIndex;

  constructor(
    hostSource: string,
    embeddedSource: string,
    segments: readonly EmbeddedSourceMapSegment[],
  ) {
    validateSegments(segments);
    this.hostSource = hostSource;
    this.embeddedSource = embeddedSource;
    this.segments = [...segments];
    this.#hostIndex = new SourceCoordinateIndex(hostSource);
    this.#embeddedIndex = new SourceCoordinateIndex(embeddedSource);
    for (const segment of segments) {
      if (
        segment.embeddedEnd > embeddedSource.length ||
        segment.hostEnd > hostSource.length
      ) {
        throw new RangeError("Source-map segment exceeds source length");
      }
      if (
        embeddedSource.slice(segment.embeddedStart, segment.embeddedEnd) !==
        hostSource.slice(segment.hostStart, segment.hostEnd)
      ) {
        throw new TypeError(
          "Lossless source-map segments must map identical text",
        );
      }
    }
  }

  embeddedToHost(range: ExactSourceRange): ExactSourceRange | null {
    const translated = translateRange(
      range.startCoordinate.utf16Offset,
      range.endCoordinate.utf16Offset,
      this.segments,
      "embedded-to-host",
    );
    return translated
      ? this.#hostIndex.range(translated[0], translated[1])
      : null;
  }

  hostToEmbedded(range: ExactSourceRange): ExactSourceRange | null {
    const translated = translateRange(
      range.startCoordinate.utf16Offset,
      range.endCoordinate.utf16Offset,
      this.segments,
      "host-to-embedded",
    );
    return translated
      ? this.#embeddedIndex.range(translated[0], translated[1])
      : null;
  }
}
