import { describe, it, expect } from "vitest";
import { gtmosSlugFor, canonicalClientSlug } from "../../src/config/slug-aliases";

describe("slug-aliases", () => {
  it("maps our external_id to the GTMOS slug for divergent clients", () => {
    expect(gtmosSlugFor("bridgeit")).toBe("bridge-it");
    expect(gtmosSlugFor("gtg")).toBe("geographic-technologies-group");
    expect(gtmosSlugFor("studer")).toBe("studer-education");
  });

  it("passes through a slug with no divergence", () => {
    expect(gtmosSlugFor("club-hub")).toBe("club-hub");
  });

  it("resolves an inbound GTMOS/legacy slug to our canonical external_id", () => {
    expect(canonicalClientSlug("bridge-it")).toBe("bridgeit");
    expect(canonicalClientSlug("geographic-technologies-group")).toBe("gtg");
    expect(canonicalClientSlug("studer-education")).toBe("studer");
    // studor is the deleted typo — still resolves to the canonical studer.
    expect(canonicalClientSlug("studor")).toBe("studer");
  });

  it("returns an unknown/canonical slug unchanged", () => {
    expect(canonicalClientSlug("club-hub")).toBe("club-hub");
    expect(canonicalClientSlug("bridgeit")).toBe("bridgeit");
  });
});
