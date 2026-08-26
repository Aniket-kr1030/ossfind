import { parsePyStub, type ParsedPyStub } from "../api/py-stub-parser.js";
import type { Result } from "./types.js";

export const id = "G11";
export const description =
  "Python stub structural honesty: no fabricated exports from strings/docstrings/nested scopes, dynamic __all__ not authoritative, and unresolved __all__ symbols carry null signatures with notes";

const docstringSample = `"""\ndef ghost() -> str: ...\nclass GhostClass: ...\n"""\n`;
const stringAssignSample = `x = "def ghost(): pass"\n`;
const nestedFunctionSample = `def outer():\n    def inner(): ...\n`;
const nestedClassSample = `class Outer:\n    def method(self): ...\n`;
const controlSuiteSample = `if TYPE_CHECKING:\n    def ghost(): ...\n`;
const dynamicAllSample = `__all__ = a + b\ndef real_func() -> int: ...\n`;
const dynamicConcatSample = `__all__ = a + ["ghost"]\ndef real_func2() -> int: ...\n`;
const unnotedAllSample = `__all__ = ["unresolved_ghost"]\n`;
const decoyAllSample = `__all__ = ["ghost"]\nx = "def ghost(a):"\n`;

export function hasPythonStubHonestyFact(
  parser: (content: string) => ParsedPyStub = parsePyStub,
): boolean {
  // 1. Docstring must emit NO exports for ghost or GhostClass
  const docRes = parser(docstringSample);
  if (docRes.exports.some((e) => e.name === "ghost" || e.name === "GhostClass")) {
    return false;
  }

  // 2. String assignment must NOT emit ghost as a function/export
  const strRes = parser(stringAssignSample);
  if (strRes.exports.some((e) => e.name === "ghost")) {
    return false;
  }

  // 3. Nested function / class body must NOT emit inner / method as module export
  const nestedFnRes = parser(nestedFunctionSample);
  if (nestedFnRes.exports.some((e) => e.name === "inner")) {
    return false;
  }
  if (!nestedFnRes.exports.some((e) => e.name === "outer" && e.kind === "function")) {
    return false;
  }

  const nestedClsRes = parser(nestedClassSample);
  if (nestedClsRes.exports.some((e) => e.name === "method")) {
    return false;
  }
  if (!nestedClsRes.exports.some((e) => e.name === "Outer" && e.kind === "class")) {
    return false;
  }

  // 4. Control suite must NOT emit control_ghost
  const ctrlRes = parser(controlSuiteSample);
  if (ctrlRes.exports.some((e) => e.name === "ghost")) {
    return false;
  }

  // 5. Dynamic __all__ = a + b must NOT be authoritative (must fall back to declared surface and include a note)
  const dynRes = parser(dynamicAllSample);
  if (!dynRes.exports.some((e) => e.name === "real_func" && e.signature !== null)) {
    return false;
  }
  if (!dynRes.notes || !dynRes.notes.some((n) => n.includes("could not be evaluated statically"))) {
    return false;
  }

  // 6. Dynamic __all__ = a + ["ghost"] must NOT treat "ghost" as authoritative
  const dynConcatRes = parser(dynamicConcatSample);
  if (dynConcatRes.exports.some((e) => e.name === "ghost")) {
    return false;
  }
  if (!dynConcatRes.exports.some((e) => e.name === "real_func2")) {
    return false;
  }
  if (!dynConcatRes.notes || !dynConcatRes.notes.some((n) => n.includes("could not be evaluated statically"))) {
    return false;
  }

  // 7. Unresolved __all__ name must carry signature: null AND explicit note
  const unresRes = parser(unnotedAllSample);
  const unresExp = unresRes.exports.find((e) => e.name === "unresolved_ghost");
  if (!unresExp || unresExp.signature !== null) {
    return false;
  }
  if (!unresRes.notes || !unresRes.notes.some((n) => n.includes("unresolved_ghost") && n.includes("declared in __all__ but not defined or imported"))) {
    return false;
  }

  // 8. Unresolved __all__ paired with string assignment decoy must NOT have signature satisfied
  const decoyRes = parser(decoyAllSample);
  const decoyGhost = decoyRes.exports.find((e) => e.name === "ghost");
  if (!decoyGhost || decoyGhost.signature !== null) {
    return false;
  }
  if (!decoyRes.notes || !decoyRes.notes.some((n) => n.includes("ghost") && n.includes("declared in __all__ but not defined or imported"))) {
    return false;
  }

  return true;
}

export async function check(): Promise<Result> {
  try {
    return hasPythonStubHonestyFact()
      ? { status: "pass" }
      : {
          status: "fail",
          message:
            "Python stub structural honesty violated: fabricated exports from strings/docstrings/scopes, dynamic __all__ over-trusted, or unresolved __all__ name lacked null signature or explicit note",
        };
  } catch (error: unknown) {
    return { status: "fail", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function proveFailure(): Promise<Result> {
  // Mutant 1: Docstring ghost fabrication (the blocker bug)
  const mutantDocstring = (content: string): ParsedPyStub => {
    if (content.includes("docstring_fn") || content.includes("GhostClass") || content.includes('"""')) {
      return {
        exports: [{ name: "ghost", kind: "function", signature: "ghost() -> str" }],
        reExports: [],
      };
    }
    return parsePyStub(content);
  };
  const docstringDetected = !hasPythonStubHonestyFact(mutantDocstring);

  // Mutant 2: String assignment fabrication
  const mutantStringAssign = (content: string): ParsedPyStub => {
    if (content.includes('x = "def ghost(): pass"')) {
      return {
        exports: [{ name: "ghost", kind: "function", signature: "ghost()" }],
        reExports: [],
      };
    }
    return parsePyStub(content);
  };
  const stringAssignDetected = !hasPythonStubHonestyFact(mutantStringAssign);

  // Mutant 3: Nested scope emission (nested inner emitted)
  const mutantNested = (content: string): ParsedPyStub => {
    if (content.includes("def inner")) {
      return {
        exports: [
          { name: "outer", kind: "function", signature: "outer()" },
          { name: "inner", kind: "function", signature: "inner()" },
        ],
        reExports: [],
      };
    }
    return parsePyStub(content);
  };
  const nestedDetected = !hasPythonStubHonestyFact(mutantNested);

  // Mutant 4: Dynamic __all__ empty surface (authoritative empty surface)
  const mutantDynamicEmpty = (content: string): ParsedPyStub => {
    if (content.includes("__all__ = a + b")) {
      return {
        exports: [],
        reExports: [],
      };
    }
    return parsePyStub(content);
  };
  const dynamicEmptyDetected = !hasPythonStubHonestyFact(mutantDynamicEmpty);

  // Mutant 5: Un-noted __all__ ghost (ghost in __all__ emitted without note)
  const mutantUnnotedAll = (content: string): ParsedPyStub => {
    if (content.includes("unresolved_ghost")) {
      return {
        exports: [{ name: "unresolved_ghost", kind: "function", signature: null }],
        reExports: [],
        notes: [],
      };
    }
    return parsePyStub(content);
  };
  const unnotedAllDetected = !hasPythonStubHonestyFact(mutantUnnotedAll);

  // Mutant 6: String decoy satisfying __all__ name with verified signature
  const mutantDecoySatisfied = (content: string): ParsedPyStub => {
    if (content.includes('x = "def ghost(a):"') && content.includes('__all__ = ["ghost"]')) {
      return {
        exports: [{ name: "ghost", kind: "function", signature: "ghost(a)" }],
        reExports: [],
      };
    }
    return parsePyStub(content);
  };
  const decoySatisfiedDetected = !hasPythonStubHonestyFact(mutantDecoySatisfied);

  if (
    docstringDetected &&
    stringAssignDetected &&
    nestedDetected &&
    dynamicEmptyDetected &&
    unnotedAllDetected &&
    decoySatisfiedDetected
  ) {
    return { status: "detected" };
  }

  return {
    status: "undetected",
    message: `G11 mutants were not all detected: docstring=${docstringDetected}, stringAssign=${stringAssignDetected}, nested=${nestedDetected}, dynamicEmpty=${dynamicEmptyDetected}, unnotedAll=${unnotedAllDetected}, decoySatisfied=${decoySatisfiedDetected}`,
  };
}
