import { describe, expect, it } from "vitest";
import {
  findPathTrigger,
  insertPathSuggestion,
} from "../../ui/src/lib/pathReferences.js";

describe("path reference textarea helpers", () => {
  it("opens suggestions for relative paths with a slash", () => {
    expect(findPathTrigger("Read src/core/run", 17)).toEqual({
      start: 5,
      end: 17,
      prefix: "src/core/run",
    });
  });

  it("opens suggestions for absolute and home paths", () => {
    const absolute = "see /Users/robert/Per";
    expect(findPathTrigger(absolute, absolute.length)).toEqual({
      start: 4,
      end: absolute.length,
      prefix: "/Users/robert/Per",
    });
    const home = "see ~/Personal_Repositories/work";
    expect(findPathTrigger(home, home.length)).toEqual({
      start: 4,
      end: home.length,
      prefix: "~/Personal_Repositories/work",
    });
  });

  it("ignores URLs, mentions, and plain words", () => {
    expect(findPathTrigger("open https://example.com/a", 26)).toBeNull();
    expect(findPathTrigger("ask @agent/triager", 18)).toBeNull();
    expect(findPathTrigger("plainword", 9)).toBeNull();
  });

  it("replaces the active path token with the selected suggestion", () => {
    const text = "Inspect src/co before continuing";
    const trigger = findPathTrigger(text, 14);
    expect(insertPathSuggestion(text, trigger, { path: "src/core/", kind: "directory" })).toEqual({
      value: "Inspect src/core/ before continuing",
      caret: 17,
    });
  });

  it("can insert the absolute path for fields that persist backend workdirs", () => {
    const text = "src/co";
    const trigger = findPathTrigger(text, text.length);
    const suggestion = {
      path: "src/core/",
      absolute_path: "/Users/robert/Personal_Repositories/worklab/src/core",
      kind: "directory",
    };

    expect(insertPathSuggestion(text, trigger, suggestion, { preferAbsolute: true })).toEqual({
      value: "/Users/robert/Personal_Repositories/worklab/src/core",
      caret: "/Users/robert/Personal_Repositories/worklab/src/core".length,
    });
  });
});
