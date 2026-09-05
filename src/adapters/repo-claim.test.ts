import { describe, expect, it } from "vitest";
import { repositoryClaimCorroborated, repositoryIdentity } from "./repo-claim.js";

describe("repositoryIdentity", () => {
  it.each([
    ["https://github.com/psf/requests", { owner: "psf", name: "requests" }],
    ["https://github.com/psf/requests.git", { owner: "psf", name: "requests" }],
    ["https://github.com/psf/requests/tree/main", { owner: "psf", name: "requests" }],
    ["https://www.github.com/PSF/Requests", { owner: "psf", name: "requests" }],
  ])("parses %s", (url, expected) => {
    expect(repositoryIdentity(url)).toEqual(expected);
  });

  it.each([
    ["https://gitlab.com/psf/requests"],
    ["https://github.com/psf"],
    ["not a url"],
    [undefined],
  ])("returns undefined for %s", (url) => {
    expect(repositoryIdentity(url as string | undefined)).toBeUndefined();
  });
});

describe("repositoryClaimCorroborated", () => {
  // The live finding: four PyPI packages declaring psf/requests to inherit its
  // OpenSSF score, each reported SHIP 92/100 before this check existed.
  it.each([
    "definitely-not-requests",
    "degree72-requests",
    "odigos-requests",
    "requeste",
    "requests-freeproxy",
  ])("withholds corroboration from %s claiming psf/requests", (name) => {
    expect(repositoryClaimCorroborated(name, "https://github.com/psf/requests")).toBe(false);
  });

  it("is not fooled by the package name containing the repository name", () => {
    expect(repositoryClaimCorroborated("evil-axios", "https://github.com/axios/axios")).toBe(false);
    expect(repositoryClaimCorroborated("totally-legit-tokio", "https://github.com/tokio-rs/tokio")).toBe(false);
  });

  it.each([
    ["requests", "https://github.com/psf/requests"],
    ["axios", "https://github.com/axios/axios"],
    ["marked", "https://github.com/markedjs/marked"],
    ["django", "https://github.com/django/django"],
    ["flask", "https://github.com/pallets/flask"],
    ["sanitize-html", "https://github.com/apostrophecms/sanitize-html"],
    ["serde", "https://github.com/serde-rs/serde"],
    ["nokogiri", "https://github.com/sparklemotion/nokogiri"],
  ])("corroborates the plain case %s", (name, repo) => {
    expect(repositoryClaimCorroborated(name, repo)).toBe(true);
  });

  it.each([
    ["a language suffix on the repo", "commander", "https://github.com/tj/commander.js"],
    ["a language prefix on the repo", "jsonwebtoken", "https://github.com/auth0/node-jsonwebtoken"],
    ["a monorepo publishing prefixed packages", "lodash.clonedeep", "https://github.com/lodash/lodash"],
    ["an npm scope matching the org", "@babel/core", "https://github.com/babel/babel"],
    ["an org named for the package", "pytest", "https://github.com/pytest-dev/pytest"],
  ])("corroborates %s", (_label, name, repo) => {
    expect(repositoryClaimCorroborated(name, repo)).toBe(true);
  });

  it.each([
    ["no repository", undefined],
    ["a non-GitHub host", "https://gitlab.com/psf/requests"],
    ["a malformed url", "github.com/psf/requests"],
  ])("fails closed on %s", (_label, repo) => {
    expect(repositoryClaimCorroborated("requests", repo)).toBe(false);
  });

  it("fails closed on an empty package name", () => {
    expect(repositoryClaimCorroborated("", "https://github.com/psf/requests")).toBe(false);
  });
});
