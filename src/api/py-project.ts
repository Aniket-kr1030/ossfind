/**
 * Python project file parsers producing a normalized PyProjectContext.
 * Implements zero-dependency parsers for requirements.txt (PEP 508)
 * and pyproject.toml (PEP 621 subset) with fail-closed uncertainty tracking.
 */

export interface PyProjectContext {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  requiresPython?: string;
  engines?: Record<string, string>;
  license?: string;
  notes?: string[];
  uncertain?: boolean;
}

export interface Pep508Requirement {
  name: string;
  normalizedName: string;
  extras?: string[];
  specifier: string;
  marker?: string;
}

/**
 * Normalizes a Python distribution name according to PEP 503 / PEP 508 rules.
 */
export function normalizeDistributionName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * Parses a single PEP 508 requirement string.
 * Format: name [extras] version_specifiers ; markers
 */
export function parsePep508Requirement(rawLine: string): Pep508Requirement | null {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return null;

  // Split environment markers if present
  let requirementPart = line;
  let marker: string | undefined;

  const semiIndex = line.indexOf(";");
  if (semiIndex >= 0) {
    requirementPart = line.slice(0, semiIndex).trim();
    marker = line.slice(semiIndex + 1).trim();
  }

  // Remove inline comments (# ...) if not inside quotes
  const commentIndex = requirementPart.indexOf("#");
  if (commentIndex >= 0) {
    requirementPart = requirementPart.slice(0, commentIndex).trim();
  }

  if (!requirementPart) return null;

  // Direct URL / VCS references like `package @ https://...` or `git+https://...`
  if (requirementPart.includes("@") || requirementPart.startsWith("git+") || requirementPart.startsWith("http:") || requirementPart.startsWith("https:")) {
    return null;
  }

  // Match package name, optional extras [extra1,extra2], and version specifiers
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[([^\]]+)\])?\s*(.*)$/.exec(requirementPart);
  if (!match) return null;

  const [, rawName, rawExtras, rawSpecifier] = match;
  const extras = rawExtras ? rawExtras.split(",").map((item) => item.trim()).filter(Boolean) : undefined;
  let specifier = rawSpecifier.trim();

  // Strip enclosing parentheses if present e.g. (>=1.26,<3)
  if (specifier.startsWith("(") && specifier.endsWith(")")) {
    specifier = specifier.slice(1, -1).trim();
  }

  return {
    name: rawName,
    normalizedName: normalizeDistributionName(rawName),
    extras,
    specifier,
    marker,
  };
}

/**
 * Parses requirements.txt contents into a PyProjectContext.
 * Handles PEP 508 requirement lines, comments, blank lines, includes (-r/-e),
 * environment markers, and extras without external dependencies.
 */
export function parseRequirementsTxt(text: string): PyProjectContext {
  const dependencies: Record<string, string> = {};
  const notes = new Set<string>();
  let uncertain = false;

  // Join line continuations ending with backslash
  const rawLines = text.split(/\r?\n/);
  const lines: string[] = [];
  let buffer = "";

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (trimmed.endsWith("\\")) {
      buffer += (buffer ? " " : "") + trimmed.slice(0, -1).trim();
    } else {
      if (buffer) {
        lines.push(buffer + (trimmed ? " " + trimmed : ""));
        buffer = "";
      } else {
        lines.push(trimmed);
      }
    }
  }
  if (buffer) lines.push(buffer);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Handle include / option flags
    if (/^-(?:r|-requirement)\b/i.test(trimmed)) {
      notes.add(`Nested requirement file include skipped: "${trimmed}".`);
      continue;
    }
    if (/^-(?:e|-editable)\b/i.test(trimmed)) {
      notes.add(`Editable requirement option skipped: "${trimmed}".`);
      continue;
    }
    if (/^-(?:c|-constraint|-f|-i|-extra-index-url|--no-index)\b/i.test(trimmed)) {
      notes.add(`Pip option skipped: "${trimmed}".`);
      continue;
    }

    if (trimmed.includes("@") || trimmed.startsWith("git+") || trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      notes.add(`Cannot evaluate direct URL or VCS requirement "${trimmed}".`);
      uncertain = true;
      continue;
    }

    const parsed = parsePep508Requirement(trimmed);
    if (!parsed) {
      notes.add(`Could not parse requirement line "${trimmed}".`);
      uncertain = true;
      continue;
    }

    if (parsed.extras && parsed.extras.length > 0) {
      notes.add(`Ignored extras [${parsed.extras.join(", ")}] for package "${parsed.name}".`);
    }

    if (parsed.marker) {
      notes.add(`Recorded environment marker "${parsed.marker}" for package "${parsed.name}".`);
    }

    // Normalized name as key for consistent lookup
    dependencies[parsed.normalizedName] = parsed.specifier || "*";
  }

  return {
    dependencies,
    notes: [...notes].sort(),
    ...(uncertain ? { uncertain: true } : {}),
  };
}

/**
 * Minimal, zero-dependency reader for PEP 621 pyproject.toml files.
 * Extracts [project] dependencies and requires-python.
 * If the file is too complex or non-PEP 621, degrades gracefully to unknown.
 */
export function parsePyprojectToml(text: string): PyProjectContext {
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  const notes = new Set<string>();
  let requiresPython: string | undefined;
  let license: string | undefined;
  let uncertain = false;

  const lines = text.split(/\r?\n/);
  let currentSection = "";
  let inDependenciesArray = false;
  let inDevDependenciesArray = false;
  let dependenciesBuffer = "";
  let hasProjectSection = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const commentIndex = rawLine.indexOf("#");
    const line = (commentIndex >= 0 ? rawLine.slice(0, commentIndex) : rawLine).trim();
    if (!line) continue;

    // Table headers e.g. [project], [project.optional-dependencies], [tool.poetry]
    const sectionMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (currentSection === "project") {
        hasProjectSection = true;
      }
      inDependenciesArray = false;
      inDevDependenciesArray = false;
      continue;
    }

    if (currentSection === "project") {
      // Dynamic fields check
      const dynamicMatch = /^dynamic\s*=\s*\[(.*)\]$/s.exec(line);
      if (dynamicMatch) {
        const dynamicFields = dynamicMatch[1].replace(/["']/g, "").split(",").map((s) => s.trim());
        if (dynamicFields.includes("dependencies") || dynamicFields.includes("requires-python")) {
          notes.add(`pyproject.toml declares dynamic field(s) [${dynamicFields.join(", ")}]; cannot statically resolve.`);
          uncertain = true;
        }
        continue;
      }

      // requires-python = ">=3.10"
      const pythonMatch = /^requires-python\s*=\s*["']([^"']+)["']/.exec(line);
      if (pythonMatch) {
        requiresPython = pythonMatch[1].trim();
        continue;
      }

      // license = "MIT" or license = { text = "MIT" } or license = { file = "LICENSE" }
      const licenseSimpleMatch = /^license\s*=\s*["']([^"']+)["']/.exec(line);
      if (licenseSimpleMatch) {
        license = licenseSimpleMatch[1].trim();
        continue;
      }
      const licenseTextMatch = /^license\s*=\s*\{\s*text\s*=\s*["']([^"']+)["']\s*\}/.exec(line);
      if (licenseTextMatch) {
        license = licenseTextMatch[1].trim();
        continue;
      }
      const licenseFileMatch = /^license\s*=\s*\{\s*file\s*=\s*["']([^"']+)["']\s*\}/.exec(line);
      if (licenseFileMatch) {
        notes.add(`License file reference "${licenseFileMatch[1]}" cannot be resolved statically.`);
        uncertain = true;
        continue;
      }

      // Single-line dependencies = ["pkg>=1.0", "other"]
      const singleLineDepsMatch = /^dependencies\s*=\s*\[(.*)\]$/.exec(line);
      if (singleLineDepsMatch) {
        parseTomlStringArray(singleLineDepsMatch[1], dependencies, notes, () => { uncertain = true; });
        continue;
      }

      // Start of multiline dependencies = [
      if (/^dependencies\s*=\s*\[/.test(line)) {
        inDependenciesArray = true;
        dependenciesBuffer = line.slice(line.indexOf("[") + 1);
        if (dependenciesBuffer.includes("]")) {
          const content = dependenciesBuffer.slice(0, dependenciesBuffer.indexOf("]"));
          parseTomlStringArray(content, dependencies, notes, () => { uncertain = true; });
          inDependenciesArray = false;
          dependenciesBuffer = "";
        }
        continue;
      }
    }

    if (inDependenciesArray) {
      if (line.includes("]")) {
        dependenciesBuffer += " " + line.slice(0, line.indexOf("]"));
        parseTomlStringArray(dependenciesBuffer, dependencies, notes, () => { uncertain = true; });
        inDependenciesArray = false;
        dependenciesBuffer = "";
      } else {
        dependenciesBuffer += " " + line;
      }
      continue;
    }

    if (currentSection === "project.optional-dependencies" || currentSection.startsWith("project.optional-dependencies.")) {
      // Optional dependencies (e.g. dev = ["pytest>=7.0"])
      const singleLineOptMatch = /^[A-Za-z0-9_.-]+\s*=\s*\[(.*)\]$/.exec(line);
      if (singleLineOptMatch) {
        parseTomlStringArray(singleLineOptMatch[1], devDependencies, notes, () => { uncertain = true; });
        continue;
      }

      if (/^[A-Za-z0-9_.-]+\s*=\s*\[/.test(line)) {
        inDevDependenciesArray = true;
        dependenciesBuffer = line.slice(line.indexOf("[") + 1);
        if (dependenciesBuffer.includes("]")) {
          const content = dependenciesBuffer.slice(0, dependenciesBuffer.indexOf("]"));
          parseTomlStringArray(content, devDependencies, notes, () => { uncertain = true; });
          inDevDependenciesArray = false;
          dependenciesBuffer = "";
        }
        continue;
      }
    }

    if (inDevDependenciesArray) {
      if (line.includes("]")) {
        dependenciesBuffer += " " + line.slice(0, line.indexOf("]"));
        parseTomlStringArray(dependenciesBuffer, devDependencies, notes, () => { uncertain = true; });
        inDevDependenciesArray = false;
        dependenciesBuffer = "";
      } else {
        dependenciesBuffer += " " + line;
      }
      continue;
    }
  }

  if (!hasProjectSection) {
    notes.add("No [project] table found in pyproject.toml (PEP 621 metadata expected; tool-specific sections like [tool.poetry] are not supported by this minimal reader).");
    uncertain = true;
  }

  return {
    dependencies,
    ...(Object.keys(devDependencies).length > 0 ? { devDependencies } : {}),
    ...(requiresPython ? { requiresPython, engines: { python: requiresPython } } : {}),
    ...(license ? { license } : {}),
    notes: [...notes].sort(),
    ...(uncertain ? { uncertain: true } : {}),
  };
}

function parseTomlStringArray(
  content: string,
  targetMap: Record<string, string>,
  notes: Set<string>,
  onUncertain: () => void,
): void {
  // Extract all single or double quoted strings
  const stringRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  let match: RegExpExecArray | null;

  while ((match = stringRegex.exec(content)) !== null) {
    const rawVal = match[1] ?? match[2] ?? "";
    const parsed = parsePep508Requirement(rawVal);
    if (!parsed) {
      notes.add(`Could not parse dependency "${rawVal}" from pyproject.toml.`);
      onUncertain();
      continue;
    }

    if (parsed.extras && parsed.extras.length > 0) {
      notes.add(`Ignored extras [${parsed.extras.join(", ")}] for package "${parsed.name}".`);
    }

    if (parsed.marker) {
      notes.add(`Recorded environment marker "${parsed.marker}" for package "${parsed.name}".`);
    }

    targetMap[parsed.normalizedName] = parsed.specifier || "*";
  }

  // If there is non-whitespace, non-comma content that was not matched as strings
  const remaining = content.replace(stringRegex, "").replace(/[\s,]/g, "");
  if (remaining.length > 0) {
    notes.add(`Encountered unparsed TOML array tokens: "${remaining}".`);
    onUncertain();
  }
}
