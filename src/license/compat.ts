import type { LicenseCompatResult } from "../contracts/index.js";

// Helper sets for license categorization (normalized to lowercase)
const PERMISSIVE = new Set(["mit", "apache-2.0", "bsd-2-clause", "bsd-3-clause", "isc"]);
const WEAK_COPYLEFT = new Set(["mpl-2.0", "lgpl-3.0"]);
const GPL_STRONG = new Set(["gpl-3.0"]);
const AGPL_STRONG = new Set(["agpl-3.0"]);

const LEGAL_ADVICE_DISCLAIMER = "Disclaimer: This is guidance, NOT legal advice.";

/**
 * Normalizes a license identifier string.
 */
function normalizeLicense(license: string | null | undefined): string {
  if (!license) return "unknown";
  const trimmed = license.trim().toLowerCase();
  if (PERMISSIVE.has(trimmed)) return trimmed;
  if (WEAK_COPYLEFT.has(trimmed)) return trimmed;
  if (GPL_STRONG.has(trimmed)) return trimmed;
  if (AGPL_STRONG.has(trimmed)) return trimmed;
  
  // Handle alias mapping / variations
  if (trimmed === "bsd-2-clause-freebsd" || trimmed === "bsd-2-clause-netbsd") return "bsd-2-clause";
  if (trimmed === "bsd-3-clause-clear") return "bsd-3-clause";

  /*
   * SPDX expressions need conservative handling.  A dependency expression
   * that contains a GPL/AGPL path cannot be treated as permissive merely
   * because another operand is MIT: the caller may select the copyleft path.
   * This deliberately recognizes the license family rather than attempting
   * to make a legal choice among OR operands.
   */
  if (/(^|[^a-z0-9-])agpl-\d+(?:\.\d+)?(?:-(?:only|or-later))?\+?(?=$|[^a-z0-9-])/i.test(trimmed)) {
    return "agpl-3.0";
  }
  if (/(^|[^a-z0-9-])lgpl-\d+(?:\.\d+)?(?:-(?:only|or-later))?\+?(?=$|[^a-z0-9-])/i.test(trimmed)) {
    return "lgpl-3.0";
  }
  if (/(^|[^a-z0-9-])gpl-\d+(?:\.\d+)?(?:-(?:only|or-later))?\+?(?=$|[^a-z0-9-])/i.test(trimmed)) {
    return "gpl-3.0";
  }
  
  return "unknown";
}

/**
 * Checks compatibility between the project's license and a component's license.
 * 
 * @param projectLicense License of the consuming project (defaults to a permissive "MIT")
 * @param componentLicense License of the dependency component
 * @returns LicenseCompatResult
 */
export function checkLicense(
  projectLicense: string | null | undefined,
  componentLicense: string | null | undefined
): LicenseCompatResult {
  const proj = normalizeLicense(projectLicense || "mit");
  const comp = normalizeLicense(componentLicense);

  const notesSuffix = ` [${LEGAL_ADVICE_DISCLAIMER}]`;

  // Unknown component license
  if (comp === "unknown") {
    return {
      compatible: "conditional",
      obligations: ["Perform manual license audit and compliance checks."],
      notes: "License could not be determined. Manual review is necessary." + notesSuffix,
    };
  }

  // Permissive components are compatible with everything
  if (PERMISSIVE.has(comp)) {
    return {
      compatible: "yes",
      obligations: ["Retain copyright and license notices."],
      notes: `Permissive license (${componentLicense}) is compatible with the project license (${projectLicense || "MIT"}).` + notesSuffix,
    };
  }

  // Weak copyleft component (MPL-2.0, LGPL-3.0)
  if (WEAK_COPYLEFT.has(comp)) {
    if (PERMISSIVE.has(proj)) {
      return {
        compatible: "conditional",
        obligations: [
          "Disclose source code of the component (and any modifications to it) under the same license.",
          "Retain copyright and license notices.",
          "Keep the component as a dynamically linked library if applicable."
        ],
        notes: `Weak copyleft license (${componentLicense}) is conditionally compatible with a permissive project license (${projectLicense || "MIT"}) when kept as a separate library.` + notesSuffix,
      };
    }
    if (WEAK_COPYLEFT.has(proj)) {
      if (proj === comp) {
        return {
          compatible: "yes",
          obligations: [
            "Retain copyright and license notices.",
            "Disclose modifications to the component under the same license."
          ],
          notes: `Matching weak copyleft licenses (${componentLicense}) are compatible.` + notesSuffix,
        };
      } else {
        return {
          compatible: "conditional",
          obligations: [
            "Disclose source code of the component (and any modifications to it) under the same license.",
            "Retain copyright and license notices.",
            "Comply with both license terms simultaneously."
          ],
          notes: `Weak copyleft license (${componentLicense}) is conditionally compatible with a different weak copyleft project license (${projectLicense}).` + notesSuffix,
        };
      }
    }
    if (GPL_STRONG.has(proj) || AGPL_STRONG.has(proj)) {
      return {
        compatible: "conditional",
        obligations: [
          "Disclose source code of the component and any modifications under the same license.",
          "Retain copyright and license notices."
        ],
        notes: `Weak copyleft license (${componentLicense}) is conditionally compatible with a copyleft project license (${projectLicense}).` + notesSuffix,
      };
    }
  }

  // GPL-3.0 component
  if (GPL_STRONG.has(comp)) {
    if (proj === "gpl-3.0" || proj === "agpl-3.0") {
      return {
        compatible: "yes",
        obligations: [
          `Disclose the full project source code under ${proj === "agpl-3.0" ? "AGPL-3.0" : "GPL-3.0"}.`,
          "Retain copyright and license notices."
        ],
        notes: `GPL-3.0 component is compatible with a ${proj.toUpperCase()} project.` + notesSuffix,
      };
    }
    // Permissive, Weak Copyleft, or other copyleft
    return {
      compatible: "no",
      obligations: [],
      notes: `GPL-3.0 is a strong copyleft license and cannot be used in a ${projectLicense || "MIT"} project without relicensing the project.` + notesSuffix,
    };
  }

  // AGPL-3.0 component
  if (AGPL_STRONG.has(comp)) {
    if (proj === "agpl-3.0") {
      return {
        compatible: "yes",
        obligations: [
          "Disclose the full project source code under AGPL-3.0.",
          "Retain copyright and license notices.",
          "Provide source code access to network/web users of the application."
        ],
        notes: "AGPL-3.0 is fully compatible with an AGPL-3.0 project." + notesSuffix,
      };
    }
    return {
      compatible: "no",
      obligations: [],
      notes: `AGPL-3.0 is a strong copyleft license with network disclosure requirements and is incompatible with a ${projectLicense || "MIT"} project.` + notesSuffix,
    };
  }

  // Fallback for safety
  return {
    compatible: "conditional",
    obligations: ["Perform manual license audit and compliance checks."],
    notes: `Compatibility could not be fully verified for component license (${componentLicense}) against project license (${projectLicense || "MIT"}).` + notesSuffix,
  };
}
