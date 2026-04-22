import { describe, it, expect } from "vitest";
import { parseVerdict } from "../../core/review.js";

describe("parseVerdict", () => {
  describe("valid verdicts", () => {
    it("plain APPROVE", () => {
      const result = parseVerdict("VERDICT: APPROVE");
      expect(result).toEqual({ verdict: "APPROVE", notes: "" });
    });

    it("APPROVE with trailing text (notes ignored)", () => {
      const result = parseVerdict("VERDICT: APPROVE\n\nLooks good");
      expect(result).toEqual({ verdict: "APPROVE", notes: "" });
    });

    it("REJECT with bullets", () => {
      const result = parseVerdict("VERDICT: REJECT\n\n- fix X\n- fix Y");
      expect(result).toEqual({ verdict: "REJECT", notes: "- fix X\n- fix Y" });
    });

    it("REJECT with no notes", () => {
      const result = parseVerdict("VERDICT: REJECT");
      expect(result).toEqual({ verdict: "REJECT", notes: "" });
    });

    it("leading whitespace before verdict line", () => {
      const result = parseVerdict("  VERDICT: APPROVE");
      expect(result).toEqual({ verdict: "APPROVE", notes: "" });
    });

    it("leading blank lines before verdict (first non-blank line)", () => {
      const result = parseVerdict("\n\nVERDICT: APPROVE");
      expect(result).toEqual({ verdict: "APPROVE", notes: "" });
    });

    it("REJECT with preserved blank lines in notes", () => {
      const result = parseVerdict("VERDICT: REJECT\n\n- one\n\n- two\n");
      expect(result).toEqual({ verdict: "REJECT", notes: "- one\n\n- two" });
    });
  });

  describe("invalid verdicts", () => {
    it("lowercase rejected", () => {
      const result = parseVerdict("verdict: approve");
      expect(result).toEqual({ verdict: null, notes: "" });
    });

    it("mixed case rejected", () => {
      const result = parseVerdict("Verdict: Approve");
      expect(result).toEqual({ verdict: null, notes: "" });
    });

    it("missing verdict line", () => {
      const result = parseVerdict("Looks fine to me");
      expect(result).toEqual({ verdict: null, notes: "" });
    });

    it("word boundary matters: APPROVED doesn't match", () => {
      const result = parseVerdict("VERDICT: APPROVED");
      expect(result).toEqual({ verdict: null, notes: "" });
    });

    it("word boundary matters: REJECT with continuation doesn't match", () => {
      const result = parseVerdict("VERDICT: REJECTS");
      expect(result).toEqual({ verdict: null, notes: "" });
    });
  });

  describe("empty/nullish/non-string input", () => {
    it("empty string", () => {
      const result = parseVerdict("");
      expect(result).toEqual({ verdict: null, notes: "" });
    });

    it("whitespace-only string", () => {
      const result = parseVerdict("   \n  \t  ");
      expect(result).toEqual({ verdict: null, notes: "" });
    });

    it("null", () => {
      const result = parseVerdict(null);
      expect(result).toEqual({ verdict: null, notes: "" });
    });

    it("undefined", () => {
      const result = parseVerdict(undefined);
      expect(result).toEqual({ verdict: null, notes: "" });
    });

    it("non-string (number)", () => {
      const result = parseVerdict(42);
      expect(result).toEqual({ verdict: null, notes: "" });
    });

    it("non-string (object)", () => {
      const result = parseVerdict({ text: "VERDICT: APPROVE" });
      expect(result).toEqual({ verdict: null, notes: "" });
    });
  });

  describe("edge cases", () => {
    it("APPROVE with extra whitespace around verdict", () => {
      const result = parseVerdict("VERDICT:   APPROVE");
      expect(result).toEqual({ verdict: "APPROVE", notes: "" });
    });

    it("REJECT with multiline notes preserving structure", () => {
      const result = parseVerdict("VERDICT: REJECT\n\nIssue 1:\n- subpoint a\n- subpoint b\n\nIssue 2:\n- other");
      expect(result).toEqual({
        verdict: "REJECT",
        notes: "Issue 1:\n- subpoint a\n- subpoint b\n\nIssue 2:\n- other",
      });
    });

    it("verdict line preceded by blank lines and other text", () => {
      const result = parseVerdict("Some preamble\n\n\nVERDICT: APPROVE\nMore text");
      expect(result).toEqual({ verdict: null, notes: "" });
    });

    it("VERDICT: REJECT with only trailing whitespace in notes", () => {
      const result = parseVerdict("VERDICT: REJECT\n\n   \n  ");
      expect(result).toEqual({ verdict: "REJECT", notes: "" });
    });

    it("tabs and mixed whitespace before verdict line", () => {
      const result = parseVerdict("\t  \t VERDICT: APPROVE");
      expect(result).toEqual({ verdict: "APPROVE", notes: "" });
    });
  });
});
