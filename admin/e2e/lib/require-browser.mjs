// A missing Playwright / Chromium normally SKIPS a real-browser suite (exit 0): the template has no npm dependencies and a developer
// without a browser must still get a clean run. In CI that silent skip hid the whole browser coverage, so CI sets REQUIRE_BROWSER_TESTS=1:
// then the same condition is a FAILURE (exit 1). Every browser suite that can skip goes through this one function.
export function skipOrFail(message) {
  if (process.env.REQUIRE_BROWSER_TESTS === "1") {
    console.error(`FAIL ${message} (REQUIRE_BROWSER_TESTS=1: a real-browser suite may not be skipped)`);
    process.exit(1);
  }
  console.log(`SKIP ${message}`);
  process.exit(0);
}
