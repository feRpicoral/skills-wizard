/* eslint-env mocha */
import assert from "node:assert";
import { renderWidget } from "../src/widget.js";

if (typeof describe === "function") {
  describe("renderWidget", () => {
    it("is a function", () => {
      assert.ok(typeof renderWidget === "function");
    });
  });
}

