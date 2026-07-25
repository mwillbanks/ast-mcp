import {
  applyAiderBlockCascade as applyAiderBlockHelper,
  parseAiderBlocksFromOutput as parseAiderBlocksHelper,
} from "../helpers/aider";

export interface SearchReplaceBlock {
  filename: string;
  replace: string;
  search: string;
}
export interface AiderReplacement {
  content: string;
  method:
    | "append"
    | "exact"
    | "whitespace"
    | "relative-indentation"
    | "diff-match-patch";
}

export function parseAiderBlocks(output: string): SearchReplaceBlock[] {
  return parseAiderBlocksHelper(output);
}

export function applyAiderBlock(
  fileContent: string,
  searchInput: string,
  replaceInput: string,
): AiderReplacement {
  return applyAiderBlockHelper(fileContent, searchInput, replaceInput);
}
